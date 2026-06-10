// Unit tests for the squat pack: rep segmentation and per-rep metrics
// against a synthetic side-view squat set with known ground truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentReps, analyzeSquat, SQUAT_BANDS } from '../squat.js';
import { LM } from '../metrics.js';

// Side-view standing pose, person ~50% of frame height.
function standingPose() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
  lm[LM.NOSE] = { x: 0.50, y: 0.20, visibility: 0.95 };
  lm[LM.L_SHOULDER] = { x: 0.505, y: 0.32, visibility: 0.95 };
  lm[LM.R_SHOULDER] = { x: 0.495, y: 0.32, visibility: 0.95 };
  lm[LM.L_ELBOW] = { x: 0.52, y: 0.40, visibility: 0.9 };
  lm[LM.R_ELBOW] = { x: 0.48, y: 0.40, visibility: 0.9 };
  lm[LM.L_WRIST] = { x: 0.52, y: 0.46, visibility: 0.9 };
  lm[LM.R_WRIST] = { x: 0.48, y: 0.46, visibility: 0.9 };
  lm[LM.L_HIP] = { x: 0.505, y: 0.48, visibility: 0.95 };
  lm[LM.R_HIP] = { x: 0.495, y: 0.48, visibility: 0.95 };
  lm[LM.L_KNEE] = { x: 0.50, y: 0.59, visibility: 0.95 };
  lm[LM.R_KNEE] = { x: 0.50, y: 0.59, visibility: 0.95 };
  lm[LM.L_ANKLE] = { x: 0.50, y: 0.70, visibility: 0.95 };
  lm[LM.R_ANKLE] = { x: 0.50, y: 0.70, visibility: 0.95 };
  return lm;
}

const clone = (lm) => lm.map((p) => ({ ...p }));

// Build a set of reps at 15fps. Each rep: descend N frames, ascend N frames.
// depth = hip drop in image units (bodyH = 0.5). lean = forward shoulder
// shift at the bottom. Deep rep: hip y goes 0.48 -> 0.48+depth.
function syntheticSet({ depths = [0.13, 0.13, 0.13], lean = 0.06, descentFrames = 12, settle = 10 } = {}) {
  const fps = 15;
  const frames = [];
  let t = 0;
  const pushFrame = (lm) => { frames.push({ t, landmarks: lm }); t += 1 / fps; };

  for (let i = 0; i < settle; i++) pushFrame(clone(standingPose()));    // settle
  for (const depth of depths) {
    for (let phase = 0; phase < 2; phase++) {                          // 0=down, 1=up
      for (let s = 1; s <= descentFrames; s++) {
        const k = phase === 0 ? s / descentFrames : 1 - s / descentFrames;
        const lm = clone(standingPose());
        const drop = depth * k;
        lm[LM.L_HIP].y += drop; lm[LM.R_HIP].y += drop;
        lm[LM.NOSE].y += drop * 0.9;
        lm[LM.L_SHOULDER].y += drop * 0.92; lm[LM.R_SHOULDER].y += drop * 0.92;
        lm[LM.L_SHOULDER].x += lean * k; lm[LM.R_SHOULDER].x += lean * k;  // forward lean
        lm[LM.L_KNEE].y += drop * 0.15; lm[LM.R_KNEE].y += drop * 0.15;
        lm[LM.L_KNEE].x += 0.04 * k; lm[LM.R_KNEE].x += 0.04 * k;
        pushFrame(lm);
      }
    }
    for (let i = 0; i < 6; i++) pushFrame(clone(standingPose()));      // pause between reps
  }
  return frames;
}

test('segments the right number of reps', () => {
  const frames = syntheticSet({ depths: [0.13, 0.13, 0.13] });
  const r = analyzeSquat(frames);
  assert.equal(r.ok, true);
  assert.equal(r.repCount, 3);
});

test('reps come back in order with sane phase indices', () => {
  const frames = syntheticSet({ depths: [0.13, 0.12, 0.13] });
  const r = analyzeSquat(frames);
  for (const rep of r.reps) {
    assert.ok(rep.startIdx < rep.bottomIdx, 'start before bottom');
    assert.ok(rep.bottomIdx < rep.endIdx, 'bottom before end');
    assert.ok(rep.descentS > 0 && rep.ascentS > 0);
  }
});

test('deep reps classified at/below parallel, shallow rep flagged', () => {
  // NOTE: drops normalize by bodyH (0.5), so image-unit drops read double.
  // hip start 0.48, knee 0.59 (knee sinks ~15% of drop): hip reaches knee
  // when drop ~0.129 image units. 0.15 = clearly deep, 0.11 = shallow rep,
  // 0.04 image (8% bodyH) = below minRepDrop and shouldn't count at all.
  const frames = syntheticSet({ depths: [0.15, 0.15, 0.04] });
  const r = analyzeSquat(frames);
  assert.equal(r.repCount, 2, 'a 8%-of-height dip is not a rep');

  const frames2 = syntheticSet({ depths: [0.15, 0.15, 0.11] });
  const r2 = analyzeSquat(frames2);
  assert.equal(r2.repCount, 3);
  assert.equal(r2.reps[0].depthBand, 'deep');
  assert.equal(r2.reps[2].depthBand, 'shallow');
  const depth = r2.metrics.find((m) => m.id === 'depth');
  assert.equal(depth.band, 'mixed');
});

test('fatigue detected when last rep is much shallower', () => {
  const frames = syntheticSet({ depths: [0.16, 0.16, 0.12] });
  const r = analyzeSquat(frames);
  const consistency = r.metrics.find((m) => m.id === 'consistency');
  assert.equal(consistency.band, 'fading');
  assert.ok(r.feedback.improvements.some((i) => i.id === 'consistency'));
});

test('excessive forward lean flagged, modest lean praised', () => {
  const modest = analyzeSquat(syntheticSet({ lean: 0.06 }));
  assert.equal(modest.metrics.find((m) => m.id === 'backAngle').band, 'good');

  const folded = analyzeSquat(syntheticSet({ lean: 0.45 }));
  assert.equal(folded.metrics.find((m) => m.id === 'backAngle').band, 'folded');
  assert.ok(folded.feedback.improvements.some((i) => i.id === 'backAngle'));
});

test('fast drops flagged as rushed', () => {
  const rushed = analyzeSquat(syntheticSet({ descentFrames: 4 }));   // ~0.27s descent
  assert.equal(rushed.metrics.find((m) => m.id === 'tempo').band, 'rushed');
});

test('no reps -> honest failure, not a fake analysis', () => {
  const standing = syntheticSet({ depths: [], settle: 60 });
  const r = analyzeSquat(standing);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_reps');
});

test('3D/load limitations always disclosed', () => {
  const r = analyzeSquat(syntheticSet());
  const labels = r.notMeasured.map((n) => n.label).join(' ');
  assert.ok(/bar path/i.test(labels));
  assert.ok(/valgus|knee cave/i.test(labels));
});
