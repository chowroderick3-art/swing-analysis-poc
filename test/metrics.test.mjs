// Unit tests for metrics.js using a synthetic right-handed swing
// (side view): stance -> stride -> hip fire -> hands fire -> contact -> finish.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSwing, jointAngle, spineTilt, LM } from '../metrics.js';

function blankPose() {
  // Person ~50% of frame height, mid-frame, side view (shoulders overlap in x).
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
  lm[LM.NOSE] = { x: 0.50, y: 0.20, visibility: 0.95 };
  lm[LM.L_SHOULDER] = { x: 0.505, y: 0.32, visibility: 0.95 };
  lm[LM.R_SHOULDER] = { x: 0.495, y: 0.32, visibility: 0.95 };
  lm[LM.L_ELBOW] = { x: 0.54, y: 0.40, visibility: 0.9 };
  lm[LM.R_ELBOW] = { x: 0.46, y: 0.40, visibility: 0.9 };
  lm[LM.L_WRIST] = { x: 0.56, y: 0.45, visibility: 0.9 };
  lm[LM.R_WRIST] = { x: 0.55, y: 0.45, visibility: 0.9 };
  lm[LM.L_HIP] = { x: 0.505, y: 0.50, visibility: 0.95 };
  lm[LM.R_HIP] = { x: 0.495, y: 0.50, visibility: 0.95 };
  lm[LM.L_KNEE] = { x: 0.50, y: 0.60, visibility: 0.95 };
  lm[LM.R_KNEE] = { x: 0.50, y: 0.60, visibility: 0.95 };
  lm[LM.L_ANKLE] = { x: 0.50, y: 0.70, visibility: 0.95 };
  lm[LM.R_ANKLE] = { x: 0.46, y: 0.70, visibility: 0.95 };
  return lm;
}

const clone = (lm) => lm.map((p) => ({ ...p }));

// Build a 30fps synthetic swing. Body height in image ~0.5.
// Timeline (frames): 0-14 stance, 15-24 stride (front/L ankle moves +0.10x),
// 25-28 hips fire, 29-33 hands fire (contact at 33), 34-45 follow-through.
function syntheticSwing({ headDrift = 0.02 } = {}) {
  const frames = [];
  const fps = 30;
  let base = blankPose();
  for (let i = 0; i <= 45; i++) {
    const lm = clone(base);
    const t = i / fps;

    if (i >= 15 && i <= 24) {                        // stride: front ankle forward
      const k = (i - 15) / 9;
      lm[LM.L_ANKLE].x = 0.50 + 0.10 * k;
      lm[LM.L_KNEE].x = 0.50 + 0.06 * k;
      lm[LM.NOSE].x = 0.50 + headDrift * k;          // head drift during stride
    }
    if (i > 24) {
      lm[LM.L_ANKLE].x = 0.60; lm[LM.L_KNEE].x = 0.56;
      lm[LM.NOSE].x = 0.50 + headDrift;
    }
    if (i >= 25 && i <= 29) {                        // hips fire first
      const k = (i - 25) / 4;
      lm[LM.L_HIP].x = 0.505 + 0.05 * Math.sin(k * Math.PI);
      lm[LM.R_HIP].x = 0.495 + 0.05 * Math.sin(k * Math.PI);
    }
    if (i >= 29 && i <= 33) {                        // hands whip to contact
      const k = (i - 29) / 4;
      lm[LM.L_WRIST].x = 0.56 + 0.25 * k;
      lm[LM.R_WRIST].x = 0.55 + 0.25 * k;
      lm[LM.L_WRIST].y = 0.45 + 0.05 * k;
      lm[LM.R_WRIST].y = 0.45 + 0.05 * k;
    }
    if (i > 33 && i <= 38) {                         // decelerating follow-through
      const k = (i - 33) / 5;
      lm[LM.L_WRIST].x = 0.81 + 0.04 * k;
      lm[LM.R_WRIST].x = 0.80 + 0.04 * k;
      lm[LM.L_WRIST].y = 0.50 - 0.10 * k;
      lm[LM.R_WRIST].y = 0.50 - 0.10 * k;
    }
    if (i > 38) {
      lm[LM.L_WRIST] = { x: 0.85, y: 0.40, visibility: 0.9 };
      lm[LM.R_WRIST] = { x: 0.84, y: 0.40, visibility: 0.9 };
    }
    frames.push({ t, landmarks: lm });
  }
  return frames;
}

test('jointAngle: straight line is ~180°, right angle is ~90°', () => {
  assert.ok(Math.abs(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }) - 180) < 1e-6);
  assert.ok(Math.abs(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }) - 90) < 1e-6);
});

test('spineTilt: upright is ~0°, leaning is positive', () => {
  const lm = blankPose();
  assert.ok(spineTilt(lm) < 5);
  lm[LM.L_SHOULDER].x += 0.1; lm[LM.R_SHOULDER].x += 0.1;
  assert.ok(spineTilt(lm) > 20);
});

test('rejects too-short input', () => {
  const r = analyzeSwing(syntheticSwing().slice(0, 4));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_enough_frames');
});

test('detects key moments in the right order', () => {
  const r = analyzeSwing(syntheticSwing());
  assert.equal(r.ok, true);
  const k = r.keyMoments;
  assert.ok(k.strideStart !== null, 'stride detected');
  assert.ok(k.footPlant !== null, 'foot plant detected');
  assert.ok(k.strideStart < k.footPlant, 'stride before plant');
  assert.ok(k.footPlant < k.contact, 'plant before contact');
  assert.ok(k.contact < k.finish, 'contact before finish');
  // contact should be at/near the wrist-speed peak (frames 29-34)
  assert.ok(k.contact >= 28 && k.contact <= 36, `contact ~33, got ${k.contact}`);
});

test('measures stride length close to ground truth (20% of body height)', () => {
  const r = analyzeSwing(syntheticSwing());
  const stride = r.metrics.find((m) => m.id === 'stride');
  // ankle travel 0.10 in image, body height 0.50 -> 20% of height
  assert.ok(Math.abs(stride.value - 0.20) < 0.06, `stride ~0.20, got ${stride.value}`);
});

test('quiet head scores good; big drift flagged as improvement', () => {
  const quiet = analyzeSwing(syntheticSwing({ headDrift: 0.01 }));
  const hQuiet = quiet.metrics.find((m) => m.id === 'headDrift');
  assert.equal(hQuiet.band, 'good');
  assert.ok(quiet.feedback.strengths.some((s) => s.id === 'headDrift'));

  const drifty = analyzeSwing(syntheticSwing({ headDrift: 0.09 }));   // 0.09/0.5 = 18% of height
  const hDrift = drifty.metrics.find((m) => m.id === 'headDrift');
  assert.equal(hDrift.band, 'needs_work');
  assert.ok(drifty.feedback.improvements.some((s) => s.id === 'headDrift'));
});

test('detects hips firing before hands', () => {
  const r = analyzeSwing(syntheticSwing());
  const seq = r.metrics.find((m) => m.id === 'sequence');
  assert.ok(seq.value !== null);
  assert.ok(seq.value > 0, `hips should lead hands, lead=${seq.value}ms`);
});

test('classifies side view and reports honest not-measured list', () => {
  const r = analyzeSwing(syntheticSwing());
  assert.equal(r.view, 'side');
  const labels = r.notMeasured.map((n) => n.label).join(' ');
  assert.ok(/attack angle/i.test(labels), '3D limitations are always disclosed');
});

test('every surfaced feedback item carries a measurement and confidence', () => {
  const r = analyzeSwing(syntheticSwing());
  for (const item of [...r.feedback.strengths, ...r.feedback.improvements]) {
    assert.ok(item.measured && item.measured.length > 0);
    assert.ok(['high', 'medium', 'low'].includes(item.confidence));
  }
});
