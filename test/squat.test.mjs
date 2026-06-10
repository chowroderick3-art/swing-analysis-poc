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

import { scoreRep, gradeOf } from '../squat.js';

// Variant generator: hips rise first on ascent (lean increases early ascent)
function hipsFirstSet() {
  const fps = 15, frames = [];
  let t = 0;
  const push = (lm) => { frames.push({ t, landmarks: lm }); t += 1 / fps; };
  for (let i = 0; i < 10; i++) push(clone(standingPose()));
  for (let rep = 0; rep < 3; rep++) {
    for (let phase = 0; phase < 2; phase++) {
      for (let s = 1; s <= 12; s++) {
        const k = phase === 0 ? s / 12 : 1 - s / 12;
        const lm = clone(standingPose());
        const drop = 0.14 * k;
        lm[LM.L_HIP].y += drop; lm[LM.R_HIP].y += drop;
        lm[LM.NOSE].y += drop * 0.9;
        lm[LM.L_SHOULDER].y += drop * 0.92; lm[LM.R_SHOULDER].y += drop * 0.92;
        // descent: modest lean; early ascent: lean INCREASES (hips shoot up)
        const ascendK = phase === 1 ? (1 - k) : 0;          // 0->1 over ascent
        const extraLean = phase === 1 && ascendK < 0.6 ? 0.18 * (ascendK / 0.6) : 0;
        lm[LM.L_SHOULDER].x += 0.05 * k + extraLean;
        lm[LM.R_SHOULDER].x += 0.05 * k + extraLean;
        lm[LM.L_KNEE].y += drop * 0.15; lm[LM.R_KNEE].y += drop * 0.15;
        push(lm);
      }
    }
    for (let i = 0; i < 6; i++) push(clone(standingPose()));
  }
  return frames;
}

// Front-view set: shoulders/hips wide, knees cave inward at the bottom
function frontViewSet({ cave = true } = {}) {
  const fps = 15, frames = [];
  let t = 0;
  const push = (lm) => { frames.push({ t, landmarks: lm }); t += 1 / fps; };
  const frontPose = () => {
    const lm = clone(standingPose());
    lm[LM.L_SHOULDER].x = 0.62; lm[LM.R_SHOULDER].x = 0.38;   // wide = facing camera
    lm[LM.L_HIP].x = 0.58; lm[LM.R_HIP].x = 0.42;
    lm[LM.L_KNEE].x = 0.58; lm[LM.R_KNEE].x = 0.42;
    lm[LM.L_ANKLE].x = 0.58; lm[LM.R_ANKLE].x = 0.42;
    return lm;
  };
  for (let i = 0; i < 10; i++) push(frontPose());
  for (let rep = 0; rep < 3; rep++) {
    for (let phase = 0; phase < 2; phase++) {
      for (let s = 1; s <= 12; s++) {
        const k = phase === 0 ? s / 12 : 1 - s / 12;
        const lm = frontPose();
        const drop = 0.14 * k;
        lm[LM.L_HIP].y += drop; lm[LM.R_HIP].y += drop;
        lm[LM.NOSE].y += drop * 0.9;
        lm[LM.L_SHOULDER].y += drop * 0.92; lm[LM.R_SHOULDER].y += drop * 0.92;
        lm[LM.L_KNEE].y += drop * 0.15; lm[LM.R_KNEE].y += drop * 0.15;
        if (cave) { lm[LM.L_KNEE].x -= 0.05 * k; lm[LM.R_KNEE].x += 0.05 * k; }
        push(lm);
      }
    }
    for (let i = 0; i < 6; i++) push(frontPose());
  }
  return frames;
}

test('set score: clean set scores high, faulty set scores lower', () => {
  const clean = analyzeSquat(syntheticSet({ depths: [0.15, 0.15, 0.15] }));
  assert.ok(clean.setScore >= 90, `clean set ~A, got ${clean.setScore}`);
  assert.equal(clean.setGrade, gradeOf(clean.setScore));
  assert.equal(clean.repScores.length, 3);

  const sloppy = analyzeSquat(syntheticSet({ depths: [0.11, 0.11, 0.11], descentFrames: 4 }));
  assert.ok(sloppy.setScore < clean.setScore, 'shallow+rushed scores lower');
});

test('hips shooting up first detected and coached', () => {
  const r = analyzeSquat(hipsFirstSet());
  const m = r.metrics.find((x) => x.id === 'hipsFirst');
  assert.equal(m.band, 'fault');
  assert.ok(r.feedback.improvements.some((i) => i.id === 'hipsFirst'));

  const cleanR = analyzeSquat(syntheticSet());
  assert.equal(cleanR.metrics.find((x) => x.id === 'hipsFirst').band, 'good');
});

test('front view: knee cave measured, depth honestly declared unmeasurable', () => {
  const r = analyzeSquat(frontViewSet({ cave: true }));
  assert.equal(r.view, 'front');
  const cave = r.metrics.find((m) => m.id === 'kneeCave');
  assert.equal(cave.band, 'caving');
  assert.ok(!r.metrics.some((m) => m.id === 'depth'), 'no depth metric from the front');
  assert.ok(r.notMeasured.some((n) => /depth/i.test(n.label)), 'depth listed as not measurable');

  const good = analyzeSquat(frontViewSet({ cave: false }));
  assert.equal(good.metrics.find((m) => m.id === 'kneeCave').band, 'good');
});

test('set summary mentions rep count and best rep', () => {
  const r = analyzeSquat(syntheticSet());
  assert.ok(/3 reps tracked/.test(r.summary), r.summary);
  assert.ok(/Best rep/.test(r.summary), r.summary);
});
