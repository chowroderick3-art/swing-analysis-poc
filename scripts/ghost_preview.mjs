// Visual QA for the ghost model swing: renders a filmstrip of sampled
// phases to PNG via headless Chrome so the model can be inspected by eye.
// Usage: node scripts/ghost_preview.mjs [out.png] [--anim]
import { sampleModelPose, GHOST_KEYS, GHOST_FACTS } from '../ghost.js';
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || '/tmp/ghost_preview.png';

const BONES = [
  ['trailAnkle', 'trailKnee'], ['trailKnee', 'trailHip'],
  ['leadAnkle', 'leadKnee'], ['leadKnee', 'leadHip'],
  ['leadHip', 'trailHip'], ['leadShoulder', 'trailShoulder'],
  ['leadHip', 'leadShoulder'], ['trailHip', 'trailShoulder'],
  ['leadShoulder', 'leadElbow'], ['leadElbow', 'leadWrist'],
  ['trailShoulder', 'trailElbow'], ['trailElbow', 'trailWrist'],
  ['leadAnkle', 'leadToe'], ['trailAnkle', 'trailToe'],
];

// One cell: model space x in [-0.45, 0.65], y in [0, 1.05], y flipped.
const CW = 220, CH = 300, PAD = 8;
const X0 = -0.45, X1 = 0.65, Y1 = 1.02;
const sx = (x) => PAD + ((x - X0) / (X1 - X0)) * (CW - 2 * PAD);
const sy = (y) => CH - PAD - (y / Y1) * (CH - 2 * PAD);

function cellSvg(pose, label, ox) {
  let s = `<g transform="translate(${ox},0)">`;
  s += `<rect x="0" y="0" width="${CW}" height="${CH}" fill="#0f172a" stroke="#334155"/>`;
  s += `<line x1="0" y1="${sy(0)}" x2="${CW}" y2="${sy(0)}" stroke="#475569" stroke-dasharray="4 4"/>`;
  for (const [a, b] of BONES) {
    s += `<line x1="${sx(pose[a].x)}" y1="${sy(pose[a].y)}" x2="${sx(pose[b].x)}" y2="${sy(pose[b].y)}" stroke="#e2e8f0" stroke-width="3.5" stroke-linecap="round"/>`;
  }
  const scx = (pose.leadShoulder.x + pose.trailShoulder.x) / 2;
  const scy = (pose.leadShoulder.y + pose.trailShoulder.y) / 2;
  const r = Math.hypot(sx(pose.nose.x) - sx(scx), sy(pose.nose.y) - sy(scy)) * 0.52;
  s += `<circle cx="${sx(pose.nose.x)}" cy="${sy(pose.nose.y)}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="3"/>`;
  // joints
  for (const name of Object.keys(pose)) {
    s += `<circle cx="${sx(pose[name].x)}" cy="${sy(pose[name].y)}" r="2.5" fill="#38bdf8"/>`;
  }
  s += `<text x="8" y="18" fill="#94a3b8" font-family="sans-serif" font-size="13">${label}</text></g>`;
  return s;
}

// Row 1: the 9 authored keyframes. Rows 2-3: 18 evenly sampled phases
// (shows interpolation quality between keys).
const cells1 = GHOST_KEYS.map((k) => ({ pose: k.pose, label: `${k.name} (${k.p})` }));
const N = 18;
const cells2 = Array.from({ length: N }, (_, i) => {
  const p = i / (N - 1);
  return { pose: sampleModelPose(p), label: `p=${p.toFixed(2)}` };
});

const rows = [cells1, cells2.slice(0, 9), cells2.slice(9)];
const W = CW * 9, H = CH * rows.length;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
rows.forEach((row, r) => {
  svg += `<g transform="translate(0,${r * CH})">`;
  row.forEach((c, i) => { svg += cellSvg(c.pose, c.label, i * CW); });
  svg += '</g>';
});
svg += '</svg>';

const html = `<!doctype html><body style="margin:0">${svg}</body>`;
writeFileSync('/tmp/ghost_preview.html', html);

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
await page.goto('file:///tmp/ghost_preview.html');
await page.screenshot({ path: out });
await browser.close();
console.log('facts:', JSON.stringify(GHOST_FACTS));
console.log('wrote', out);
