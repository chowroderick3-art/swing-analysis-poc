import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSwing, jointAngle, spineTilt, LM } from '../metrics.js';
import { blankPose, syntheticSwing } from './helpers.mjs';

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
