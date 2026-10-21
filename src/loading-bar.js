// Builds a clean transparent loading-bar texture from the repository's high-quality JPEG.
// The JPEG has a checkerboard baked into its background; remove the connected light-neutral pixels
// and crop to the wood frame so neither HTML nor Phaser shows the damaged older WebP asset.
(() => {
  const sourceUrl = new URL('assets/ui/load rectangle.jpeg', document.baseURI).href;
  const fallbackUrl = new URL('assets/ui/load rectangle staging.webp', document.baseURI).href;
  const bar = document.querySelector('#boot .bar');
  const displayImage = document.getElementById('bootLoadRectangle');

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image: ' + url));
      img.src = url;
      if (img.complete && img.naturalWidth > 0) resolve(img);
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

  function showImage(url, width, height) {
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        displayImage.width = width;
        displayImage.height = height;
        bar.classList.add('ready');
        resolve();
      };
      displayImage.onload = done;
      displayImage.onerror = done;
      displayImage.src = url;
      if (displayImage.complete && displayImage.naturalWidth > 0) done();
    });
  }

  window.ShapeyLoadingBar = {};

  // Show a lightweight bar as soon as the small fallback image arrives. The expensive JPEG cleanup
  // then runs in the background while Phaser starts loading the game assets.
  window.ShapeyLoadingBar.ready = (async () => {
    const fallback = await loadImage(fallbackUrl);
    const canvas = document.createElement('canvas');
    canvas.width = fallback.naturalWidth;
    canvas.height = fallback.naturalHeight;
    const fallbackContext = canvas.getContext('2d');
    if (!fallbackContext) throw new Error('Canvas is unavailable for the loading-bar fallback');
    fallbackContext.drawImage(fallback, 0, 0);

    window.ShapeyLoadingBar.url = fallbackUrl;
    window.ShapeyLoadingBar.canvas = canvas;
    await showImage(fallbackUrl, fallback.naturalWidth, fallback.naturalHeight);

    // Do not hold the game boot screen hostage while removing the checkerboard baked into the JPEG.
      const clean = async () => {
        try {
        const source = await loadImage(sourceUrl);
        const clean = cleanAndCrop(source);
        const url = clean.canvas.toDataURL('image/webp', 0.95);

        // Keep the same canvas object so a Phaser CanvasTexture already using it can be refreshed.
        canvas.width = clean.width;
        canvas.height = clean.height;
        const cleanContext = canvas.getContext('2d');
        if (!cleanContext) throw new Error('Canvas is unavailable for the cleaned loading bar');
        cleanContext.drawImage(clean.canvas, 0, 0);

        window.ShapeyLoadingBar.url = url;
        await showImage(url, clean.width, clean.height);
        const game = window.game;
        if (game && game.textures && game.textures.exists('loadRect')) {
          game.textures.get('loadRect').refresh();
        }
        return { url, width: clean.width, height: clean.height, canvas };
        } catch (error) {
          console.warn('Could not clean the loading-bar source; keeping the fast fallback.', error);
          return { url: fallbackUrl, width: canvas.width, height: canvas.height, canvas, fallback: true };
        }
      };
      // Let the browser paint the visible placeholder and let Phaser begin before the pixel cleanup runs.
      window.ShapeyLoadingBar.cleaning = new Promise((resolve) => {
        const schedule = () => window.setTimeout(async () => resolve(await clean()), 0);
        if (window.requestAnimationFrame) window.requestAnimationFrame(schedule);
        else schedule();
      });

    return { url: fallbackUrl, width: fallback.naturalWidth, height: fallback.naturalHeight, canvas, fallback: true };
  })();
})();
