// App orchestration: load model -> step through video frames -> pose
// landmarks -> metrics.js -> render honest results.
import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.mjs';
import { analyzeSwing } from './metrics.js';

const $ = (id) => document.getElementById(id);
const els = {
  upload: $('uploadCard'), progress: $('progressCard'), result: $('resultCard'),
  error: $('errorCard'), errorMsg: $('errorMsg'),
  progressLabel: $('progressLabel'), progressFill: $('progressFill'), progressDetail: $('progressDetail'),
  video: $('video'), overlay: $('overlay'), scrubber: $('scrubber'), moments: $('moments'),
  quality: $('qualityCard'), strengths: $('strengthsCard'), improve: $('improveCard'),
  metrics: $('metricsCard'), honesty: $('honestyCard'),
};

const COARSE_STEP = 0.18;   // s between frames, pass 1 (find the swing)
const FINE_STEP = 1 / 30;   // s between frames, pass 2 (measure the swing)
const FINE_BEFORE = 2.2;    // s before the motion peak to analyze
const FINE_AFTER = 1.4;     // s after
const MAX_SCAN = 40;        // s of video scanned in pass 1

let landmarker = null;
let fakeTs = 0;             // detectForVideo requires monotonic timestamps
let fineFrames = [];        // [{ t, landmarks }]
let analysis = null;

function show(stage) {
  for (const k of ['upload', 'progress', 'result', 'error']) {
    els[k].classList.toggle('hidden', k !== stage);
  }
}

function progress(label, frac, detail = '') {
  els.progressLabel.textContent = label;
  els.progressFill.style.width = `${Math.round(frac * 100)}%`;
  els.progressDetail.textContent = detail;
}

function fail(msg) {
  els.errorMsg.textContent = msg;
  show('error');
}

async function getLandmarker() {
  if (landmarker) return landmarker;
  progress('Loading analysis engine…', 0.1, 'Downloading pose model (one time, ~19MB)');
  const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: './models/pose_landmarker_full.task', delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  return landmarker;
}

function seek(video, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('seek timeout')), 5000);
    const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

function detectAt(video) {
  fakeTs += 33.34;
  const res = landmarker.detectForVideo(video, fakeTs);
  return res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
}

async function scanVideo(video) {
  // Pass 1: coarse scan to find the most violent wrist motion (the swing).
  const dur = Math.min(video.duration, MAX_SCAN);
  const coarse = [];
  for (let t = 0; t < dur; t += COARSE_STEP) {
    await seek(video, t);
    const lm = detectAt(video);
    if (lm) coarse.push({ t, lm });
    progress('Finding your swing…', 0.15 + 0.35 * (t / dur), `${t.toFixed(1)}s / ${dur.toFixed(1)}s`);
  }
  if (coarse.length < 4) return null;

  let peakT = coarse[0].t, peakV = -1;
  for (let i = 1; i < coarse.length; i++) {
    const a = coarse[i - 1], b = coarse[i];
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const v = (d(b.lm[15], a.lm[15]) + d(b.lm[16], a.lm[16])) / (b.t - a.t || 1);
    if (v > peakV) { peakV = v; peakT = b.t; }
  }

  // Pass 2: fine scan around the peak.
  const start = Math.max(0, peakT - FINE_BEFORE);
  const end = Math.min(video.duration - 0.01, peakT + FINE_AFTER);
  const frames = [];
  const n = Math.ceil((end - start) / FINE_STEP);
  let i = 0;
  for (let t = start; t <= end; t += FINE_STEP, i++) {
    await seek(video, t);
    const lm = detectAt(video);
    if (lm) frames.push({ t, landmarks: lm });
    progress('Measuring the swing…', 0.5 + 0.45 * (i / n), `frame ${i + 1} of ~${n}`);
  }
  return frames;
}

async function handleFile(file) {
  show('progress');
  try {
    await getLandmarker();
    const video = els.video;
    video.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('decode'));
    });
    if (!video.duration || video.duration === Infinity) throw new Error('decode');

    fineFrames = (await scanVideo(video)) || [];
    if (fineFrames.length < 8) {
      return fail('We couldn’t find a person clearly enough in this video. Make sure the whole body is visible and well lit, then try again.');
    }
    analysis = analyzeSwing(fineFrames);
    if (!analysis.ok) {
      return fail('We found a person but couldn’t identify a swing in this clip. Try a video with one clear swing in it.');
    }
    renderResults();
  } catch (e) {
    fail(e.message === 'decode'
      ? 'This video format couldn’t be played in the browser. Try recording with the regular camera app.'
      : `Something went wrong during analysis (${e.message}). Reload and try again.`);
  }
}

/* ---------- rendering ---------- */

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [0, 11], [0, 12],
];

function drawFrame(idx) {
  const f = fineFrames[idx];
  const video = els.video, canvas = els.overlay;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!f) return;
  const px = (p) => [p.x * canvas.width, p.y * canvas.height];

  ctx.lineWidth = Math.max(2, canvas.width / 240);
  ctx.strokeStyle = 'rgba(56,189,248,0.9)';
  for (const [a, b] of CONNECTIONS) {
    const [ax, ay] = px(f.landmarks[a]); const [bx, by] = px(f.landmarks[b]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.fillStyle = '#4ade80';
  for (const p of f.landmarks) {
    const [x, y] = px(p);
    ctx.beginPath(); ctx.arc(x, y, Math.max(2.5, canvas.width / 220), 0, Math.PI * 2); ctx.fill();
  }
}

async function showFrame(idx) {
  idx = Math.max(0, Math.min(fineFrames.length - 1, idx));
  els.scrubber.value = idx;
  try { await seek(els.video, fineFrames[idx].t); } catch { /* keep last decoded frame */ }
  drawFrame(idx);
  for (const chip of els.moments.children) {
    chip.classList.toggle('active', Number(chip.dataset.idx) === idx);
  }
}

const CONF_LABEL = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence', none: 'not measured' };
const dot = (c) => `<span class="confdot conf-${c}"></span>`;

function renderResults() {
  show('result');
  const a = analysis;

  els.scrubber.max = fineFrames.length - 1;
  els.scrubber.oninput = (e) => showFrame(Number(e.target.value));

  const momentLabels = [
    ['stance', 'Stance'], ['strideStart', 'Stride'], ['footPlant', 'Foot plant'],
    ['contact', 'Contact ⚡'], ['finish', 'Finish'],
  ];
  els.moments.innerHTML = '';
  for (const [key, label] of momentLabels) {
    const idx = a.keyMoments[key];
    if (idx === null || idx === undefined) continue;
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.dataset.idx = idx;
    chip.onclick = () => showFrame(idx);
    els.moments.appendChild(chip);
  }

  const q = a.quality;
  const viewLabel = { side: 'side view 👍', angled: 'angled view', front: 'facing the camera' }[a.view];
  els.quality.innerHTML = `
    <h2>How much can you trust this?</h2>
    <div class="scoreRow">
      <div class="scoreRing">${q.score}</div>
      <div>
        <p><b>Video quality score.</b> We measured ${q.swingFrames} frames during the swing (${viewLabel}).</p>
      </div>
    </div>
    ${q.tips.length ? `<p class="hint"><b>Get a better analysis:</b> ${q.tips.join(' ')}</p>` : '<p class="hint">Great capture — this is about as good as a single phone camera gets.</p>'}
  `;

  const fbHtml = (item) => `
    <div class="fb">
      <div class="title">${item.title}</div>
      <div class="measured">${dot(item.confidence)}measured: ${item.measured} · ${CONF_LABEL[item.confidence]}</div>
      <div class="detail">${item.detail}</div>
    </div>`;

  els.strengths.innerHTML = `<h2>✅ What you’re doing well</h2>` +
    (a.feedback.strengths.length ? a.feedback.strengths.map(fbHtml).join('') : '<p class="hint">Nothing stood out as a clear strength in this clip — see the quality tips above.</p>');
  els.improve.innerHTML = `<h2>🔧 What to work on</h2>` +
    (a.feedback.improvements.length ? a.feedback.improvements.map(fbHtml).join('') : '<p class="hint">No clear issues found at this confidence level. Nice swing!</p>');

  els.metrics.innerHTML = `<h2>📐 All measurements</h2>` + a.metrics.map((m) => `
    <div class="metric">
      <span class="label">${dot(m.confidence)}${m.label}</span>
      <span class="value">${m.display}</span>
    </div>`).join('');

  els.honesty.innerHTML = `<h2>🪞 What we could NOT measure</h2><ul>` +
    a.notMeasured.map((n) => `<li><b>${n.label}</b> — ${n.reason}</li>`).join('') + '</ul>';

  showFrame(a.keyMoments.contact);
}

/* ---------- wiring ---------- */

$('fileInput').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
});
$('resetBtn').onclick = () => { show('upload'); $('fileInput').value = ''; };
$('errorReset').onclick = () => { show('upload'); $('fileInput').value = ''; };

// expose for headless verification
window.__poc = { handleFile, get analysis() { return analysis; }, get frames() { return fineFrames; } };
