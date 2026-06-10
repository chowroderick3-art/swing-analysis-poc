import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const server = spawn('python3', ['-m', 'http.server', '8124'], { cwd: '/home/user/swing-analysis-poc' });
await sleep(800);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900 });
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const v = document.createElement('video');
      v.src = '/.e2e_camera.mp4';
      v.loop = true; v.muted = true; v.playsInline = true;
      document.body.append(v);          // keep it rendering
      await v.play();
      console.log('fake camera playing', v.videoWidth, v.videoHeight);
      return v.captureStream();
    };
  });
  await page.goto('http://localhost:8124/?debug=1&cpu=1', { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.__poc.startMode('cage'));
  await page.click('#cageStartBtn');
  await page.waitForFunction(`!document.getElementById('cageView').classList.contains('hidden')`, { timeout: 60000 });
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const status = await page.$eval('#cageStatus', (el) => el.textContent);
    const dbg = await page.$eval('#cageDebug', (el) => el.textContent);
    const reps = await page.$eval('#cageReps', (el) => el.textContent);
    const vid = await page.$eval('#cageVideo', (v) => `${v.videoWidth}x${v.videoHeight} t=${v.currentTime.toFixed(1)} paused=${v.paused}`);
    console.log(`t+${(i + 1) * 3}s status=${status} reps=${reps} video=${vid} :: ${dbg}`);
  }
  await page.screenshot({ path: '/tmp/cage_debug.png' });
} finally { await browser.close(); server.kill(); }
