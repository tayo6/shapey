#!/usr/bin/env node
'use strict';

// Lists the meme files for src/memes.js. A browser cannot list a folder, so this writes
// assets/memes/manifest.json:  { "audio": { "<folder>": [files] }, "gifs": { "<folder>": [files] } }
//
//   node tools/build-memes-manifest.js          write the manifest
//   node tools/build-memes-manifest.js --check  exit 1 when the manifest is out of date (used in CI)
//
// Add a file to a folder under assets/memes/audio or assets/memes/gifs, then run this again.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MEMES_DIR = path.join(ROOT, 'assets', 'memes');
const MANIFEST = path.join(MEMES_DIR, 'manifest.json');
const KINDS = {
  audio: new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac']),
  gifs: new Set(['.gif', '.webp', '.png', '.jpg', '.jpeg', '.avif']),
};

const byName = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// Folder path (relative to the kind's directory, "/" separated) -> sorted list of matching files.
function scan(kind) {
  const base = path.join(MEMES_DIR, kind);
  const result = {};
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && KINDS[kind].has(path.extname(e.name).toLowerCase())).map((e) => e.name).sort(byName);
    if (rel && files.length) result[rel] = files;
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => byName(a.name, b.name))) {
      walk(path.join(dir, entry.name), rel ? rel + '/' + entry.name : entry.name);
    }
  };
  if (fs.existsSync(base)) walk(base, '');
  return result;
}

function build() {
  return { audio: scan('audio'), gifs: scan('gifs') };
}

function main(argv) {
  const text = JSON.stringify(build(), null, 2) + '\n';
  if (argv.includes('--check')) {
    const current = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
    if (current !== text) {
      console.error('assets/memes/manifest.json is out of date. Run: node tools/build-memes-manifest.js');
      return 1;
    }
    console.log('assets/memes/manifest.json is up to date.');
    return 0;
  }
  fs.writeFileSync(MANIFEST, text);
  const count = (group) => Object.values(group).reduce((n, files) => n + files.length, 0);
  const manifest = JSON.parse(text);
  console.log('Wrote assets/memes/manifest.json: ' + count(manifest.audio) + ' audio, ' + count(manifest.gifs) + ' picture files.');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { build, scan };
