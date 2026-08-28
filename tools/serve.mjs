// Local dev server that refuses to let the browser cache anything.
//
//   node tools/serve.mjs [port]
//
// `python3 -m http.server` is fine for a quick look, but it sends no cache
// headers, so browsers — Safari especially — will happily serve you a stale
// index.html or a stale yin.wasm after you rebuild, and you end up debugging
// code that is not running.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0]))
    .replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`tuner: http://localhost:${PORT}/           (multi-file build)`);
  console.log(`       http://localhost:${PORT}/tuner.html (single-file build)`);
  console.log(`       add ?debug for the diagnostics panel`);
  console.log('caching disabled — a reload always gets the current build');
});
