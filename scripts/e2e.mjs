// Headless end-to-end check across all five modes: serve the app, run a
// real video through Coach Report, then visit Game / Tutorial / Progress
// (which reuse the analysis) and Side-by-Side (same video as both lanes).
// Usage: node scripts/e2e.mjs <video-path>
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const video = process.argv[2];
if (!video) { console.error('usage: node scripts/e2e.mjs <video>'); process.exit(2); }

const server = spawn('python3', ['-m', 'http.server', '8123'], { cwd: new URL('..', import.meta.url).pathname });
await sleep(800);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

const visible = (id) => `!document.getElementById('${id}').classList.contains('hidden')`;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:8123/', { waitUntil: 'networkidle0', timeout: 60000 });
  console.log('page loaded — home view');
  await page.screenshot({ path: '/tmp/poc_home.png' });

  const upload = async () => {
    const input = await page.$('#fileInput');
    await input.uploadFile(video);
  };
  const waitFor = (id) => page.waitForFunction(
    `${visible(id)} || ${visible('errorView')}`, { timeout: 600000, polling: 1000 });
  const assertNoError = async (label) => {
    if (await page.evaluate(`${visible('errorView')}`)) {
      console.error(`FAILED at ${label}:`, await page.$eval('#errorMsg', (el) => el.textContent));
      process.exit(1);
    }
  };

  // --- Coach Report ---
  await page.click('[data-mode="report"]');
  await upload();
  console.log('analyzing (coach report)…');
  await waitFor('reportView');
  await assertNoError('report');
  const summary = await page.evaluate(() => {
    const a = window.__poc.analysis;
    return {
      frames: window.__poc.frames.length, view: a.view, keyMoments: a.keyMoments,
      quality: { score: a.quality.score, swingFrames: a.quality.swingFrames },
      metrics: a.metrics.map((m) => ({ id: m.id, display: m.display, band: m.band, confidence: m.confidence })),
      strengths: a.feedback.strengths.map((s) => s.title),
      improvements: a.feedback.improvements.map((s) => s.title),
    };
  });
  console.log('REPORT:', JSON.stringify(summary, null, 2));

  // honesty invariants
  const badFeedback = await page.evaluate(() => {
    const a = window.__poc.analysis;
    const ids = new Set(a.metrics.filter((m) => m.confidence === 'none' || m.band === 'unknown').map((m) => m.id));
    return [...a.feedback.strengths, ...a.feedback.improvements].filter((f) => ids.has(f.id)).map((f) => f.id);
  });
  if (badFeedback.length) { console.error('HONESTY VIOLATION: unmeasured metrics in feedback:', badFeedback); process.exit(1); }
  await page.screenshot({ path: '/tmp/poc_report.png', fullPage: true });

  // --- Game (reuses analysis) ---
  await page.evaluate(() => window.__poc.startMode('game'));
  await page.waitForFunction(visible('gameView'), { timeout: 10000 });
  await sleep(1500);                                          // count-up animation
  const score = await page.$eval('#bigScore', (el) => el.textContent).catch(() => null);
  const grade = await page.$eval('#gameView .grade', (el) => el.textContent).catch(() => null);
  console.log('GAME: score =', score, 'grade =', grade);
  await page.screenshot({ path: '/tmp/poc_game.png', fullPage: true });

  // --- Tutorial (reuses analysis) ---
  await page.evaluate(() => window.__poc.startMode('tutorial'));
  await page.waitForFunction(visible('tutorialView'), { timeout: 10000 });
  await sleep(600);
  const phase1 = await page.$eval('#tutorialView h3', (el) => el.textContent);
  let clicks = 0;
  while (clicks++ < 10) {
    const label = await page.$eval('#tutorialView .buttons .btn.primary', (el) => el.textContent);
    if (label.startsWith('Done')) break;
    await page.click('#tutorialView .buttons .btn.primary');
    await sleep(300);
  }
  console.log('TUTORIAL: first phase =', JSON.stringify(phase1), '· stepped through', clicks, 'phases');
  await page.screenshot({ path: '/tmp/poc_tutorial.png', fullPage: true });

  // --- Progress (history written by the runs above) ---
  await page.evaluate(() => window.__poc.startMode('progress'));
  await page.waitForFunction(visible('progressTrackView'), { timeout: 10000 });
  const histRows = await page.$$eval('.histRow', (els) => els.length);
  console.log('PROGRESS: history rows =', histRows);
  await page.screenshot({ path: '/tmp/poc_progress.png', fullPage: true });

  // --- Side-by-Side (same video as both lanes) ---
  await page.evaluate(() => window.__poc.startMode('compare'));
  await page.waitForFunction(visible('uploadView'), { timeout: 10000 });
  await upload();
  console.log('analyzing (compare, swing 1)…');
  await page.waitForFunction(`${visible('uploadView')} || ${visible('errorView')}`, { timeout: 600000, polling: 1000 });
  await assertNoError('compare-1');
  await upload();
  console.log('analyzing (compare, swing 2)…');
  await waitFor('compareView');
  await assertNoError('compare-2');
  const cmpRows = await page.$$eval('.cmpRow', (els) => els.length);
  console.log('COMPARE: delta rows =', cmpRows);
  await page.screenshot({ path: '/tmp/poc_compare.png', fullPage: true });

  console.log('ALL FIVE MODES OK. screenshots: /tmp/poc_{home,report,game,tutorial,progress,compare}.png');
} finally {
  await browser.close();
  server.kill();
}
