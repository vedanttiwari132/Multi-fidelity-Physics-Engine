// Bundles the whole game (code, Three.js, PeerJS) into one self-contained dist/index.html
// that works on any static host: itch.io, Netlify, GitHub Pages, Cloudflare Pages, your own server.
//   npm install
//   npm run build
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  charset: 'ascii',
  legalComments: 'eof',   // keeps the Three.js / PeerJS license notices
  target: 'es2020',
  write: false,
});
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');

let html = readFileSync('index.html', 'utf8');
html = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '');
const tag = '<script type="module" src="./src/main.js"></script>';
if (!html.includes(tag)) throw new Error('index.html no longer loads ./src/main.js; update build.mjs');
html = html.replace(tag, () => `<script type="module">\n${js}\n</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB`);
