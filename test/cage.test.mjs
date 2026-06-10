// Cage Mode logic tests: swing detection on a simulated live stream and
// the one-cue feedback engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SwingDetector, pickCue, summarizeSession, CAGE_TUNING } from '../cage.js';
import { LM } from '../metrics.js';

// Live-stream simulator at 30fps: idle stance, then a swing (wrist whips
// ~0.5 image-units in ~0.15s = far past enterSpeed), follow-through, idle.
function stancePose(wristX = 0.56) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
  lm[LM.NOSE] = { x: 0.50, y: 0.20, visibility: 0.95 };
  lm[LM.L_SHOULDER] = { x: 0.505, y: 0.32, visibility: 0.95 };
  lm[LM.R_SHOULDER] = { x: 0.495, y: 0.32, visibility: 0.95 };
  lm[LM.L_WRIST] = { x: wristX, y: 0.45, visibility: 0.9 };
  lm[LM.R_WRIST] = { x: wristX - 0.01, y: 0.45, visibility: 0.9 };
  lm[LM.L_HIP] = { x: 0.505, y: 0.50, visibility: 0.95 };
  lm[LM.R_HIP] = { x: 0.495, y: 0.50, visibility: 0.95 };
  lm[LM.L_KNEE] = { x: 0.50, y: 0.60, visibility: 0.95 };
  lm[LM.R_KNEE] = { x: 0.50, y: 0.60, visibility: 0.95 };
  lm[LM.L_ANKLE] = { x: 0.50, y: 0.70, visibility: 0.95 };
  lm[LM.R_ANKLE] = { x: 0.46, y: 0.70, visibility: 0.95 };
  return lm;
}

function* liveStream({ swings = 1, idleS = 1.2, betweenS = 4.5 } = {}) {
  const fps = 30;
  let t = 0;
  const emit = (lm) => ({ t: (t += 1 / fps), landmarks: lm });
  for (let i = 0; i < idleS * fps; i++) yield emit(stancePose());
  for (let s = 0; s < swings; s++) {
    for (let i = 1; i <= 6; i++) {                     // 0.2s violent swing
      yield emit(stancePose(0.56 + 0.09 * i));
    }
    for (let i = 0; i < 8; i++) yield emit(stancePose(1.10));   // hold finish
    for (let i = 0; i < betweenS * fps; i++) yield emit(stancePose());
  }
}

test('detects exactly one swing per swing, none on idle', () => {
  const d = new SwingDetector();
  let events = 0;
  for (const f of liveStream({ swings: 3 })) {
    if (d.push(f)?.type === 'swing') events++;
  }
  assert.equal(events, 3);

  const idle = new SwingDetector();
  let idleEvents = 0;
  for (const f of liveStream({ swings: 0, idleS: 8 })) {
    if (idle.push(f)?.type === 'swing') idleEvents++;
  }
  assert.equal(idleEvents, 0);
});

test('swing window includes pre-swing stance context', () => {
  const d = new SwingDetector();
  let evt = null;
  for (const f of liveStream({ swings: 1 })) {
    const e = d.push(f);
    if (e?.type === 'swing') { evt = e; break; }
  }
  assert.ok(evt, 'swing detected');
  assert.ok(evt.frames.length >= 20, `window has context, got ${evt.frames.length}`);
  assert.ok(evt.peakSpeed >= CAGE_TUNING.minSwingPeak);
});

test('slow arm wiggle does not fire', () => {
  const d = new SwingDetector();
  const fps = 30;
  let t = 0, fired = 0;
  for (let i = 0; i < fps * 6; i++) {
    t += 1 / fps;
    const wob = stancePose(0.56 + 0.03 * Math.sin(i / 6));   // gentle sway
    if (d.push({ t, landmarks: wob })?.type === 'swing') fired++;
  }
  assert.equal(fired, 0);
});

const metric = (id, band, confidence = 'high') => ({ id, band, confidence });

test('pickCue: one cue, highest-priority fault wins', () => {
  const a = { ok: true, metrics: [
    metric('headDrift', 'needs_work'), metric('frontKnee', 'soft'), metric('posture', 'check'),
  ] };
  const cue = pickCue(a, 60);
  assert.equal(cue.tone, 'fix');
  assert.equal(cue.metricId, 'headDrift', 'head drift outranks knee and posture');
});

test('pickCue: low-confidence faults are never spoken', () => {
  const a = { ok: true, metrics: [
    metric('headDrift', 'needs_work', 'low'), metric('stride', 'long', 'low'),
  ] };
  const cue = pickCue(a, 80);
  assert.equal(cue.tone, 'praise', 'nothing speakable -> praise, not a guess');
});

test('pickCue: clean swing gets rotating praise; failed analysis gets honest miss', () => {
  const clean = { ok: true, metrics: [metric('headDrift', 'good'), metric('frontKnee', 'good')] };
  const c1 = pickCue(clean, 95, 0), c2 = pickCue(clean, 95, 1);
  assert.equal(c1.tone, 'praise');
  assert.notEqual(c1.text, c2.text, 'praise rotates');
  assert.equal(pickCue({ ok: false }, null).tone, 'miss');
});

test('summarizeSession aggregates reps, scores, top cue', () => {
  const s = summarizeSession([
    { score: 70, cue: { tone: 'fix', text: 'Keep your head still. Eyes on the contact point.' } },
    { score: 85, cue: { tone: 'praise', text: 'Good swing!' } },
    { score: 60, cue: { tone: 'fix', text: 'Keep your head still. Eyes on the contact point.' } },
    { score: null, cue: { tone: 'miss', text: '...' } },
  ]);
  assert.equal(s.reps, 4);
  assert.equal(s.bestScore, 85);
  assert.equal(s.bestRep, 2);
  assert.equal(s.avgScore, 72);
  assert.equal(s.topCue.count, 2);
  assert.equal(s.praises, 1);
});
