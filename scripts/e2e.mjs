// Headless end-to-end check: serve the app, upload a real swing video,
// wait for analysis, dump results, capture screenshots.
// Usage: node test/e2e.mjs <video-path>
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const video = process.argv[2];
if (!video) { console.error('usage: node test/e2e.mjs <video>'); process.exit(2); }

const server = spawn('python3', ['-m', 'http.server', '8123'], { cwd: new URL('..', import.meta.url).pathname });
await sleep(800);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 }); // phone-ish
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:8123/', { waitUntil: 'networkidle0', timeout: 60000 });
  console.log('page loaded');

  const input = await page.$('#fileInput');
  await input.uploadFile(video);
  console.log('video uploaded, analyzing…');

  // Wait for result or error (model load + two-pass scan can take a while on CPU)
  await page.waitForFunction(
    () => !document.getElementById('resultCard').classList.contains('hidden') ||
          !document.getElementById('errorCard').classList.contains('hidden'),
    { timeout: 600000, polling: 1000 },
  );

  const failed = await page.$eval('#errorCard', (el) => !el.classList.contains('hidden'));
  if (failed) {
    const msg = await page.$eval('#errorMsg', (el) => el.textContent);
    console.error('ANALYSIS FAILED:', msg);
    await page.screenshot({ path: '/tmp/poc_error.png', fullPage: true });
    process.exitCode = 1;
  } else {
    const summary = await page.evaluate(() => {
      const a = window.__poc.analysis;
      return {
        frames: window.__poc.frames.length,
        view: a.view,
        keyMoments: a.keyMoments,
        quality: a.quality,
        metrics: a.metrics.map((m) => ({ id: m.id, display: m.display, band: m.band, confidence: m.confidence })),
        strengths: a.feedback.strengths.map((s) => s.title),
        improvements: a.feedback.improvements.map((s) => s.title),
      };
    });
    console.log(JSON.stringify(summary, null, 2));
    await page.screenshot({ path: '/tmp/poc_result_top.png' });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.screenshot({ path: '/tmp/poc_result_mid.png' });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: '/tmp/poc_result_bottom.png' });
    console.log('screenshots: /tmp/poc_result_{top,mid,bottom}.png');
  }
} finally {
  await browser.close();
  server.kill();
}
