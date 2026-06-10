// Shared analysis engine: pose model lifecycle, video frame scanning,
// and skeleton overlay drawing. Used by every mode.
import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.mjs';

const FINE_STEP = 1 / 30;   // s between frames, best-effort fine pass
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

// Playback-capture scan: play the video once (muted) and capture pose
// frames live via requestVideoFrameCallback. No seeking during analysis —
// iOS Safari stalls seeks on camera-roll videos (cold decode pipeline,
// Low Power Mode, HEVC), which froze the old seek-stepping scanner.
// After playback we *attempt* a fine seek-stepped pass around the swing
// for denser sampling (the pipeline is warm by then); if seeks still
// stall we keep the playback-captured frames. Reliability first.
//
// captureFrames: shared playback capture used by every sport.
// scanVideo: baseball-style wrapper (capture + refine around peak motion).
export async function captureFrames(video, onProgress, ensurePlay, label = 'Watching the movement…') {
  const dur = Math.min(video.duration, MAX_SCAN);

  video.muted = true;
  video.currentTime = 0;
  if (ensurePlay) await ensurePlay(video);
  else await video.play();

  // requestVideoFrameCallback fires per presented frame (Safari 15.4+,
  // Chrome); fall back to rAF polling of currentTime elsewhere.
  const schedule = video.requestVideoFrameCallback
    ? (cb) => video.requestVideoFrameCallback((_now, meta) => cb(meta.mediaTime))
    : (cb) => requestAnimationFrame(() => cb(video.currentTime));

  return await new Promise((resolve, reject) => {
    const frames = [];
    let done = false;
    let lastT = -1;
    let lastTick = performance.now();
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      video.removeEventListener('ended', finish);
      try { video.pause(); } catch { /* ignore */ }
      resolve(frames);
    };
    video.addEventListener('ended', finish);
    // If the decoder stops presenting frames mid-clip, salvage what we have
    // (or fail clearly) instead of freezing the UI.
    const watchdog = setInterval(() => {
      if (done) return;
      if (performance.now() - lastTick > 8000) {
        if (frames.length >= 8) finish();
        else { done = true; clearInterval(watchdog); reject(new Error('stalled')); }
      }
    }, 1000);
    const step = (mediaTime) => {
      if (done) return;
      lastTick = performance.now();
      if (mediaTime >= dur) return finish();
      if (mediaTime - lastT >= 1 / 120) {       // skip duplicate presentations
        lastT = mediaTime;
        const lm = detectAt(video);
        if (lm) frames.push({ t: mediaTime, landmarks: lm });
        onProgress?.(label, 0.15 + 0.55 * (mediaTime / dur), `${mediaTime.toFixed(1)}s / ${dur.toFixed(1)}s`);
      }
      schedule(step);
    };
    schedule(step);
  });
}

export async function scanVideo(video, onProgress, ensurePlay) {
  const captured = await captureFrames(video, onProgress, ensurePlay, 'Watching the swing…');
  if (captured.length < 4) return null;

  // Locate the swing: peak wrist motion across captured frames.
  let peakT = captured[0].t, peakV = -1;
  for (let i = 1; i < captured.length; i++) {
    const a = captured[i - 1], b = captured[i];
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const v = (d(b.landmarks[15], a.landmarks[15]) + d(b.landmarks[16], a.landmarks[16])) / (b.t - a.t || 1);
    if (v > peakV) { peakV = v; peakT = b.t; }
  }
  const start = Math.max(0, peakT - FINE_BEFORE);
  const end = Math.min(video.duration - 0.01, peakT + FINE_AFTER);
  const windowFrames = captured.filter((f) => f.t >= start && f.t <= end);

  // Pass 2 (best-effort): denser seek-stepped sampling of the swing window.
  // Abort fast on the first sign of seek trouble — playback frames suffice.
  const fine = [];
  try {
    const n = Math.ceil((end - start) / FINE_STEP);
    let i = 0;
    for (let t = start; t <= end; t += FINE_STEP, i++) {
      await seek(video, t, 4000);
      const lm = detectAt(video);
      if (lm) fine.push({ t, landmarks: lm });
      onProgress?.('Measuring the swing…', 0.7 + 0.25 * (i / n), `frame ${i + 1} of ~${n}`);
    }
  } catch {
    onProgress?.('Measuring the swing…', 0.95, 'using live-captured frames');
  }
  return fine.length > windowFrames.length ? fine : windowFrames;
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
