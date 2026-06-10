// Headless visual check of the Swing Ghost view: serves the app, injects
// the synthetic test swing, and screenshots the overlay at key phases.
// Usage: npm i --no-save puppeteer && node scripts/ghost_e2e.mjs [outdir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer';
import { syntheticSwing } from '../test/helpers.mjs';

const outdir = process.argv[2] || '/tmp';
const root = new URL('..', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };

const server = createServer(async (req, res) => {
  try {
    const path = join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 1400, deviceScaleFactor: 2 });
page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });

// Home: baseball mode picker shows the new Ghost card.
await page.click('[data-sport="baseball"]');
await page.screenshot({ path: `${outdir}/shot_home.png` });

// Inject the synthetic swing and open the ghost view.
const frames = syntheticSwing();
await page.evaluate((f) => window.__poc.injectGhost(f), frames);
await new Promise((r) => setTimeout(r, 400));

const km = await page.evaluate(() => window.__poc.analysis.keyMoments);
console.log('keyMoments:', JSON.stringify(km));

const shotAt = async (key, idx) => {
  await page.evaluate((i) => {
    const scrub = document.querySelector('#ghostView input[type=range]');
    scrub.value = i;
    scrub.dispatchEvent(new Event('input'));
  }, idx);
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: `${outdir}/shot_ghost_${key}.png` });
  console.log(`wrote ${outdir}/shot_ghost_${key}.png`);
};

for (const key of ['stance', 'strideStart', 'footPlant', 'contact', 'finish']) {
  if (km[key] != null) await shotAt(key, km[key]);
}

await browser.close();
server.close();
