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

// Synthetic 3-rep squat set (2 deep, 1 shallow) — mirrors test/squat.test.mjs.
function syntheticSquatSet() {
  const base = () => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
    const set = (i, x, y) => { lm[i] = { x, y, visibility: 0.95 }; };
    set(0, 0.50, 0.20); set(11, 0.505, 0.32); set(12, 0.495, 0.32);
    set(13, 0.52, 0.40); set(14, 0.48, 0.40); set(15, 0.52, 0.46); set(16, 0.48, 0.46);
    set(23, 0.505, 0.48); set(24, 0.495, 0.48); set(25, 0.50, 0.59); set(26, 0.50, 0.59);
    set(27, 0.50, 0.70); set(28, 0.50, 0.70);
    return lm;
  };
  const frames = [];
  let t = 0;
  const push = (lm) => { frames.push({ t, landmarks: lm }); t += 1 / 15; };
  for (let i = 0; i < 10; i++) push(base());
  for (const depth of [0.15, 0.15, 0.11]) {
    for (let phase = 0; phase < 2; phase++) {
      for (let s = 1; s <= 12; s++) {
        const k = phase === 0 ? s / 12 : 1 - s / 12;
        const lm = base();
        const drop = depth * k;
        lm[23].y += drop; lm[24].y += drop; lm[0].y += drop * 0.9;
        lm[11].y += drop * 0.92; lm[12].y += drop * 0.92;
        lm[11].x += 0.06 * k; lm[12].x += 0.06 * k;
        lm[25].y += drop * 0.15; lm[26].y += drop * 0.15;
        push(lm);
      }
    }
    for (let i = 0; i < 6; i++) push(base());
  }
  return frames;
}

// Stage the test video inside the served directory so the fake camera can
// stream it (cleaned up at the end; gitignored).
import { copyFileSync, rmSync } from 'node:fs';
const servedVideo = new URL('../.e2e_camera.mp4', import.meta.url).pathname;
copyFileSync(video, servedVideo);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // Fake live camera: getUserMedia returns a looped real-swing video stream.
  await page.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const v = document.createElement('video');
      v.src = '/.e2e_camera.mp4';
      v.loop = true; v.muted = true; v.playsInline = true;
      v.style.position = 'fixed'; v.style.left = '-9999px';
      document.body.append(v);          // keep the element rendering frames
      await v.play();
      return v.captureStream();
    };
  });

  await page.goto('http://localhost:8123/?cpu=1', { waitUntil: 'networkidle0', timeout: 60000 }); // headless GL is software-emulated; CPU delegate is ~6x faster here
  console.log('page loaded — sport picker');
  await page.screenshot({ path: '/tmp/poc_home.png' });
  await page.click('[data-sport="baseball"]');
  await page.waitForFunction(visible('homeView'), { timeout: 10000 });
  await page.screenshot({ path: '/tmp/poc_baseball_modes.png' });

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

  // --- Squat (UI driven by synthetic frames; math is unit-tested) ---
  const squatFrames = syntheticSquatSet();
  const squat = await page.evaluate((frames) => {
    window.__poc.injectSquat(frames);
    const a = window.__poc.squatAnalysis;
    return { ok: a.ok, reps: a.repCount, bands: a.reps.map((r) => r.depthBand), metrics: a.metrics.map((m) => `${m.id}:${m.band}`) };
  }, squatFrames);
  await page.waitForFunction(visible('squatView'), { timeout: 10000 });
  await sleep(1500);                                          // count-up animation
  const scorecardRows = await page.$$eval('#squatView .histRow', (els) => els.length);
  console.log('SQUAT:', JSON.stringify(squat), '· scorecard rows =', scorecardRows);
  if (!squat.ok || squat.reps !== 3 || scorecardRows !== 3) {
    console.error('SQUAT UI FAILURE'); process.exit(1);
  }
  await page.screenshot({ path: '/tmp/poc_squat.png', fullPage: true });

  // --- Cage Mode (live loop against the fake camera) ---
  await page.evaluate(() => window.__poc.startMode('cage'));
  await page.waitForFunction(visible('cageSetupView'), { timeout: 10000 });
  await page.click('#cageStartBtn');
  await page.waitForFunction(visible('cageView'), { timeout: 60000 });
  console.log('cage live view running — waiting for swing detection on looped clip…');
  let reps = 0;
  try {
    await page.waitForFunction(
      () => !document.getElementById('cageReps').textContent.startsWith('0'),
      { timeout: 90000, polling: 500 },
    );
    reps = await page.$eval('#cageReps', (el) => parseInt(el.textContent, 10));
  } catch { /* counted below */ }
  const cageCue = await page.$eval('#cageCue', (el) => el.textContent);
  console.log('CAGE: reps =', reps, '· cue =', JSON.stringify(cageCue));
  await page.screenshot({ path: '/tmp/poc_cage.png', fullPage: true });
  if (reps < 1) { console.error('CAGE FAILURE: no swings detected on looped clip'); process.exit(1); }
  await page.click('#cageEndBtn');
  await page.waitForFunction(visible('cageSummaryView'), { timeout: 10000 });
  const cageSummary = await page.$eval('#cageSummaryView', (el) => el.textContent.slice(0, 200));
  console.log('CAGE SUMMARY:', JSON.stringify(cageSummary));
  await page.screenshot({ path: '/tmp/poc_cage_summary.png', fullPage: true });

  console.log('ALL MODES OK. screenshots: /tmp/poc_{home,baseball_modes,report,game,tutorial,progress,compare,squat,cage,cage_summary}.png');
} finally {
  rmSync(servedVideo, { force: true });
  await browser.close();
  server.kill();
}
