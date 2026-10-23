// Shapey - boot screen controller. A classic script: index.html runs it before Phaser has downloaded.
//
// The boot screen (#boot in index.html) stays hidden until everything on it is ready - the textured
// background, the Shapey logo and the load-bar plank - and is then revealed in a single step, so the
// pieces never pop in one after another.
//
// The plank is cut out of "load rectangle.jpeg", whose background has a checkerboard baked in: connected
// light-neutral pixels are removed and the picture is cropped to the wooden frame. That happens once, before
// the reveal, and the same cleaned canvas is used by the HTML boot screen and by Phaser
// (window.ShapeyLoadingBar.canvas), so the plank never changes after it is shown. The old WebP version of the
// plank ("load rectangle staging.webp") is damaged along its bottom edge and is no longer used. If the JPEG
// cannot be prepared, a plain drawn plank with the same proportions is used instead.
(() => {
  // Reveal the boot screen after this long even if something is slow (a plain plank is drawn if the JPEG is late).
  const REVEAL_TIMEOUT_MS = 6000;
  const sourceUrl = new URL('assets/ui/load rectangle.jpeg', document.baseURI).href;
  const boot = document.getElementById('boot');
  const bar = document.querySelector('#boot .bar');
  const bgImage = document.querySelector('#boot .bg');
  const logoImage = document.querySelector('#boot .logo');

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image: ' + url));
      img.src = url;
      if (img.complete && img.naturalWidth > 0) resolve(img);
    });
  }

  // Resolves once an <img> on the boot screen is downloaded and decoded (or has failed - never rejects).
  function imageReady(img) {
    if (!img) return Promise.resolve();
    const decoded = () => (typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve());
    if (img.complete) return img.naturalWidth > 0 ? decoded() : Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', () => resolve(decoded()), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  }

  function cleanAndCrop(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    const w = canvas.width;
    const h = canvas.height;
    const total = w * h;
    const background = new Uint8Array(total);
    const queue = new Uint32Array(total);
    let head = 0;
    let tail = 0;

    // The checkerboard is light and nearly neutral. Restrict removal to pixels connected
    // to the outside edge, so pale highlights inside the wooden frame remain untouched.
    const isBackground = (index) => {
      const p = index * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      return Math.min(r, g, b) >= 180 && Math.max(r, g, b) - Math.min(r, g, b) <= 48;
    };
    const add = (index) => {
      if (!background[index] && isBackground(index)) {
        background[index] = 1;
        queue[tail++] = index;
      }
    };
    for (let x = 0; x < w; x++) {
      add(x);
      add((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      add(y * w);
      add(y * w + w - 1);
    }

    while (head < tail) {
      const index = queue[head++];
      const x = index % w;
      const y = (index / w) | 0;
      if (x > 0) add(index - 1);
      if (x + 1 < w) add(index + 1);
      if (y > 0) add(index - w);
      if (y + 1 < h) add(index + w);
    }

    // Remove connected checkerboard pixels and a narrow neutral fringe left by JPEG compression.
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      if (background[i]) {
        pixels[p + 3] = 0;
        continue;
      }
      const x = i % w;
      const y = (i / w) | 0;
      let nextToBackground = false;
      if (x > 0 && background[i - 1]) nextToBackground = true;
      if (x + 1 < w && background[i + 1]) nextToBackground = true;
      if (y > 0 && background[i - w]) nextToBackground = true;
      if (y + 1 < h && background[i + w]) nextToBackground = true;
      if (nextToBackground) {
        const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
        const min = Math.min(r, g, b), max = Math.max(r, g, b);
        if (min >= 150 && max - min <= 55) pixels[p + 3] = 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (pixels[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) throw new Error('Could not isolate the wooden frame');

    // Small transparent padding prevents the cropped image from touching the canvas edge.
    const pad = 2;
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const output = document.createElement('canvas');
    output.width = cropW + pad * 2;
    output.height = cropH + pad * 2;
    const outputCtx = output.getContext('2d');
    if (!outputCtx) throw new Error('Canvas is unavailable');
    outputCtx.drawImage(canvas, minX, minY, cropW, cropH, pad, pad, cropW, cropH);
    return { canvas: output, width: output.width, height: output.height };
  }

  // Last resort if the JPEG cannot be prepared: a plain wooden plank with the same proportions and the same
  // dark slot as the real one (LOAD_TRACK in src/constants.js).
  function makeFallbackPlank() {
    const w = 840;
    const h = 175;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const wood = ctx.createLinearGradient(0, 0, 0, h);
      wood.addColorStop(0, '#a8662f');
      wood.addColorStop(1, '#6b3a1a');
      ctx.fillStyle = wood;
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#3d2210';
      ctx.strokeRect(3, 3, w - 6, h - 6);
      const grow = 6; // the slot is a little bigger than the gold fill that goes inside it
      const x = 0.0664 * w - grow;
      const y = 0.283 * h - grow;
      const slotW = (0.9326 - 0.0664) * w + grow * 2;
      const slotH = (0.7123 - 0.283) * h + grow * 2;
      ctx.fillStyle = '#24150b';
      ctx.fillRect(x, y, slotW, slotH);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d5ad72';
      ctx.strokeRect(x, y, slotW, slotH);
    }
    return { canvas, width: w, height: h };
  }

  // The canvas that shows the plank inside the HTML boot screen. index.html provides it; if an older page
  // has an <img> there instead, it is swapped for a canvas.
  function getDisplayCanvas() {
    if (!bar) return null;
    let canvas = document.getElementById('bootLoadRectangle');
    if (!canvas || canvas.tagName !== 'CANVAS') {
      const replacement = document.createElement('canvas');
      replacement.id = 'bootLoadRectangle';
      replacement.setAttribute('aria-hidden', 'true');
      replacement.style.cssText = 'display:block;width:100%;height:auto;';
      if (canvas && canvas.parentNode) canvas.parentNode.replaceChild(replacement, canvas);
      else bar.insertBefore(replacement, bar.firstChild);
      canvas = replacement;
    }
    return canvas;
  }

  // Draws the plank into the boot screen and shows the whole screen in one step.
  function reveal(plank) {
    const canvas = getDisplayCanvas();
    if (canvas) {
      canvas.width = plank.width;
      canvas.height = plank.height;
      const context = canvas.getContext('2d');
      if (context) context.drawImage(plank.canvas, 0, 0);
    }
    if (bar) bar.classList.add('ready');
    if (boot) boot.classList.add('ready');
  }

  const state = { canvas: null, width: 0, height: 0 };
  window.ShapeyLoadingBar = state;

  // Resolves (it never rejects) once the boot screen has been revealed. src/main.js starts Phaser after this,
  // and BootScene turns state.canvas into the 'loadRect' texture.
  state.ready = (async () => {
    let plank = null;
    let abandoned = false;
    const plankPrepared = loadImage(sourceUrl)
      .then((img) => {
        if (!abandoned) plank = cleanAndCrop(img);
      })
      .catch((error) => {
        console.warn('Could not prepare the loading-bar plank; using a plain one.', error);
      });
    const timeout = new Promise((resolve) => setTimeout(resolve, REVEAL_TIMEOUT_MS));

    try {
      await Promise.race([
        Promise.all([plankPrepared, imageReady(bgImage), imageReady(logoImage)]),
        timeout,
      ]);
    } catch (error) {
      console.warn('Boot screen assets were not all ready.', error);
    }
    abandoned = true;

    const final = plank || makeFallbackPlank();
    state.canvas = final.canvas;
    state.width = final.width;
    state.height = final.height;
    try {
      reveal(final);
    } catch (error) {
      console.warn('Could not show the boot screen.', error);
    }
  })();
})();
