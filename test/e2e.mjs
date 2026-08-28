// End-to-end test: runs the real page in headless Chromium with a WAV file
// standing in for the microphone, and asserts on the rendered DOM. This
// exercises the whole path — getUserMedia -> AudioWorklet -> Worker -> WASM
// -> UI — not a simulation of it.
//
//   npm i playwright        (or set CHROME_PATH to a Chrome/Chromium binary)
//   node test/e2e.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './make-fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8531;
const TOLERANCE_CENTS = 2.0;

// Both builds are exercised: the normal multi-file site and the bundled
// single file. They share every line of logic, but the single-file build
// reaches its worklet, worker and WASM by completely different routes, so a
// bug there would not show up in the other.
const BUILDS = [
  { name: 'multi-file', page: 'index.html' },
  { name: 'single-file', page: 'tuner.html' },
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
};

async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return (await import(name)).chromium; } catch { /* try next */ }
  }
  throw new Error('Install Playwright first:  npm i playwright');
}

function serve() {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'index.html' : rel);
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const { fixtures, dir } = await generate();
const chromium = await loadPlaywright();
const server = await serve();

let failed = 0;
const results = [];

for (const build of BUILDS) {
 for (const fixture of fixtures) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${dir + fixture.file}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

    await page.goto(`http://localhost:${PORT}/${build.page}`);
    await page.click('#start');
    await page.waitForFunction(() => document.body.dataset.active === 'true', null, { timeout: 15000 });
    await page.waitForTimeout(1200);   // let the median filter and needle settle

    const seen = await page.evaluate(() => ({
      note: document.getElementById('note').firstChild.textContent.trim(),
      octave: document.querySelector('#note sub').textContent.trim(),
      tuned: document.body.dataset.tuned === 'true',
      activeString: document.querySelector('.string[data-on="true"]')?.dataset.note ?? null,
      displayed: window.__tuner.state.displayed,
    }));

    const expectedNote = `${fixture.note}${fixture.octave}`;
    const centsError = seen.displayed
      ? 1200 * Math.log2(seen.displayed.freq / fixture.freq)
      : NaN;

    const problems = [];
    if (seen.note !== fixture.note) problems.push(`note ${seen.note} != ${fixture.note}`);
    if (seen.octave !== String(fixture.octave)) problems.push(`octave ${seen.octave} != ${fixture.octave}`);
    if (seen.activeString !== expectedNote) problems.push(`string ${seen.activeString} != ${expectedNote}`);
    if (!(Math.abs(centsError) <= TOLERANCE_CENTS)) problems.push(`freq off by ${centsError.toFixed(2)}¢`);
    if (seen.tuned !== (Math.abs(fixture.detune) <= 5)) {
      problems.push(`in-tune flag ${seen.tuned}, expected ${Math.abs(fixture.detune) <= 5}`);
    }
    if (pageErrors.length) problems.push(`page errors: ${pageErrors.join(' | ')}`);

    if (problems.length) failed++;
    results.push({
      build: build.name,
      file: fixture.file,
      ok: problems.length === 0,
      shown: `${seen.note}${seen.octave} ${seen.displayed ? seen.displayed.centsOff.toFixed(1) : '?'}¢`,
      expected: `${expectedNote} ${fixture.detune}¢`,
      error: centsError,
      problems,
    });
  } finally {
    await browser.close();
  }
 }
}

// A page opened from disk cannot load a blob-URL worklet (opaque origin), so
// it must fail with the explanation rather than a raw browser error.
{
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${ROOT}tuner.html`);
    await page.click('#start');
    await page.waitForFunction(
      () => /served over http/i.test(document.getElementById('status').textContent),
      null, { timeout: 8000 },
    );
    results.push({ build: 'file://', file: 'guard', ok: true, shown: 'explains itself', expected: 'explains itself', error: 0, problems: [] });
  } catch (err) {
    failed++;
    results.push({ build: 'file://', file: 'guard', ok: false, shown: '?', expected: 'explanatory message', error: NaN, problems: [String(err).split('\n')[0]] });
  } finally {
    await browser.close();
  }
}

server.close();

for (const r of results) {
  const drift = Number.isFinite(r.error) ? ` (${r.error.toFixed(2)}¢ off true pitch)` : '';
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.build.padEnd(12)} ${r.file.padEnd(18)} shown ${r.shown.padEnd(14)} expected ${r.expected.padEnd(10)}${drift}`);
  for (const p of r.problems) console.log(`        ${p}`);
}
console.log(`\n${results.length - failed}/${results.length} end-to-end cases passed`);
process.exit(failed ? 1 : 0);
