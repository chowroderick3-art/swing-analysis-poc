// Shared analysis engine: pose model lifecycle, video frame scanning,
// and skeleton overlay drawing. Used by every mode.
import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.mjs';

const COARSE_STEP = 0.18;   // s between frames, pass 1 (find the swing)
const FINE_STEP = 1 / 30;   // s between frames, pass 2 (measure the swing)
const FINE_BEFORE = 2.2;    // s before the motion peak to analyze
const FINE_AFTER = 1.4;     // s after
const MAX_SCAN = 40;        // s of video scanned in pass 1

let landmarker = null;
let fakeTs = 0;             // detectForVideo requires monotonic timestamps

export async function getLandmarker(onProgress) {
  if (landmarker) return landmarker;
  onProgress?.('Loading analysis engine…', 0.1, 'Downloading pose model (one time, ~19MB)');
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

// Seek with the iOS-Safari quirks handled:
// - same-position seeks never fire `seeked` there -> resolve immediately
// - listener is always removed, success or timeout
export function seek(video, t, timeoutMs = 8000) {
  const dur = video.duration || 0;
  t = Math.min(Math.max(t, 0), Math.max(0, dur - 0.001));
  if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.001) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      ok ? resolve() : reject(new Error('seek timeout'));
    };
    const onSeeked = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

// One stuck frame must not kill an analysis: retry once with a nudged
// timestamp, then report failure so callers can skip the frame.
async function trySeek(video, t) {
  try { await seek(video, t); return true; } catch { /* retry below */ }
  try { await seek(video, t + 0.001); return true; } catch { return false; }
}

function detectAt(video) {
  fakeTs += 33.34;
  const res = landmarker.detectForVideo(video, fakeTs);
  return res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
}

export async function loadVideoFile(video, file) {
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('decode'));
  });
  if (!video.duration || video.duration === Infinity) throw new Error('decode');
  // iOS Safari keeps the decode pipeline cold until playback has started
  // once; seeks on a cold pipeline stall forever. Muted inline play/pause
  // wakes it up (allowed without a gesture because the element is muted).
  try { await video.play(); video.pause(); } catch { /* non-fatal */ }
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

// Two-pass scan. Returns fine frames [{ t, landmarks }] around the swing.
// Stuck seeks are skipped; only a long unbroken run of them aborts.
export async function scanVideo(video, onProgress) {
  const dur = Math.min(video.duration, MAX_SCAN);
  const coarse = [];
  let stuck = 0;
  for (let t = 0; t < dur; t += COARSE_STEP) {
    if (!(await trySeek(video, t))) {
      if (++stuck >= 6) throw new Error('seek_stuck');
      continue;
    }
    stuck = 0;
    const lm = detectAt(video);
    if (lm) coarse.push({ t, lm });
    onProgress?.('Finding the swing…', 0.15 + 0.35 * (t / dur), `${t.toFixed(1)}s / ${dur.toFixed(1)}s`);
  }
  if (coarse.length < 4) return null;

  let peakT = coarse[0].t, peakV = -1;
  for (let i = 1; i < coarse.length; i++) {
    const a = coarse[i - 1], b = coarse[i];
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const v = (d(b.lm[15], a.lm[15]) + d(b.lm[16], a.lm[16])) / (b.t - a.t || 1);
    if (v > peakV) { peakV = v; peakT = b.t; }
  }

  const start = Math.max(0, peakT - FINE_BEFORE);
  const end = Math.min(video.duration - 0.01, peakT + FINE_AFTER);
  const frames = [];
  const n = Math.ceil((end - start) / FINE_STEP);
  let i = 0;
  stuck = 0;
  for (let t = start; t <= end; t += FINE_STEP, i++) {
    if (!(await trySeek(video, t))) {
      if (++stuck >= 6) throw new Error('seek_stuck');
      continue;
    }
    stuck = 0;
    const lm = detectAt(video);
    if (lm) frames.push({ t, landmarks: lm });
    onProgress?.('Measuring the swing…', 0.5 + 0.45 * (i / n), `frame ${i + 1} of ~${n}`);
  }
  return frames;
}

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [0, 11], [0, 12],
];

export function drawSkeleton(canvas, video, frame, color = 'rgba(56,189,248,0.9)') {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!frame) return;
  const px = (p) => [p.x * canvas.width, p.y * canvas.height];
  ctx.lineWidth = Math.max(2, canvas.width / 240);
  ctx.strokeStyle = color;
  for (const [a, b] of CONNECTIONS) {
    const [ax, ay] = px(frame.landmarks[a]); const [bx, by] = px(frame.landmarks[b]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.fillStyle = '#4ade80';
  for (const p of frame.landmarks) {
    const [x, y] = px(p);
    ctx.beginPath(); ctx.arc(x, y, Math.max(2.5, canvas.width / 220), 0, Math.PI * 2); ctx.fill();
  }
}
