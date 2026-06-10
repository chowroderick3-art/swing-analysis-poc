// Tests for the Swing Ghost model and its fit onto a player's video.
// The model swing itself must pass the same fundamentals our metrics
// grade players on — otherwise we'd be showing players a "model" that
// our own analyzer would flag.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GHOST_KEYS, GHOST_POINTS, GHOST_FACTS, MODEL_BODYH,
  sampleModelPose, buildGhost, ghostPhaseNotes,
} from '../ghost.js';
import { analyzeSwing, jointAngle, BANDS } from '../metrics.js';
import { syntheticSwing, mirroredSwing } from './helpers.mjs';

const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const key = (name) => GHOST_KEYS.find((k) => k.name === name).pose;

// Canonical segment lengths, measured off the solved stance keyframe.
const stance = key('stance');
const SEGS = (pose) => ({
  torso: len(mid(pose.leadHip, pose.trailHip), mid(pose.leadShoulder, pose.trailShoulder)),
  leadUpperArm: len(pose.leadShoulder, pose.leadElbow),
  trailUpperArm: len(pose.trailShoulder, pose.trailElbow),
  leadForearm: len(pose.leadElbow, pose.leadWrist),
  trailForearm: len(pose.trailElbow, pose.trailWrist),
  leadThigh: len(pose.leadHip, pose.leadKnee),
  trailThigh: len(pose.trailHip, pose.trailKnee),
  leadShank: len(pose.leadKnee, pose.leadAnkle),
  trailShank: len(pose.trailKnee, pose.trailAnkle),
});
const CANON = SEGS(stance);

test('model: anatomy holds at every sampled phase', () => {
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const pose = sampleModelPose(p);
    for (const name of GHOST_POINTS) {
      assert.ok(Number.isFinite(pose[name].x) && Number.isFinite(pose[name].y), `finite ${name} @ ${p}`);
      assert.ok(pose[name].y > -0.02, `${name} above ground @ p=${p.toFixed(2)} (y=${pose[name].y.toFixed(3)})`);
    }
    const segs = SEGS(pose);
    // Structurally enforced segments must be exact; shanks aren't enforced
    // (ankles stay planted) so they may breathe slightly mid-interpolation.
    for (const nm of ['torso', 'leadUpperArm', 'trailUpperArm', 'leadForearm', 'trailForearm', 'leadThigh', 'trailThigh']) {
      assert.ok(Math.abs(segs[nm] - CANON[nm]) < CANON[nm] * 0.02, `${nm} stable @ p=${p.toFixed(2)}`);
    }
    for (const nm of ['leadShank', 'trailShank']) {
      assert.ok(Math.abs(segs[nm] - CANON[nm]) < CANON[nm] * 0.22, `${nm} within tolerance @ p=${p.toFixed(2)} (${segs[nm].toFixed(3)} vs ${CANON[nm].toFixed(3)})`);
    }
  }
});

test('model: passes the fundamentals we grade players on', () => {
  // Firm front leg at contact.
  const c = key('contact');
  const knee = jointAngle(c.leadHip, c.leadKnee, c.leadAnkle);
  assert.ok(knee >= BANDS.frontKneeAtContact.minFirm, `front knee ${knee.toFixed(0)}° >= ${BANDS.frontKneeAtContact.minFirm}°`);

  // Quiet head, stance through contact.
  let drift = 0;
  for (let p = 0; p <= 0.80; p += 0.01) {
    drift = Math.max(drift, len(sampleModelPose(p).nose, stance.nose));
  }
  assert.ok(drift / MODEL_BODYH <= BANDS.headDrift.good + 0.01, `head drift ${(drift / MODEL_BODYH * 100).toFixed(1)}% is quiet`);

  // Stride in the healthy band.
  const travel = (key('footPlant').leadAnkle.x - stance.leadAnkle.x) / MODEL_BODYH;
  assert.ok(travel > BANDS.stride.low && travel < BANDS.stride.high, `stride ${(travel * 100).toFixed(0)}% in band`);

  // Hands stay back through foot plant, then travel forward to contact.
  const handsAt = (p) => mid(sampleModelPose(p).leadWrist, sampleModelPose(p).trailWrist).x;
  assert.ok(handsAt(0.55) < stance.leadShoulder.x, 'hands still behind the lead shoulder at foot plant');
  let prev = handsAt(0.55);
  for (let p = 0.57; p <= 0.80; p += 0.02) {
    const cur = handsAt(p);
    assert.ok(cur >= prev - 0.01, `hands keep moving toward the ball @ p=${p.toFixed(2)}`);
    prev = cur;
  }

  // Both hands stay on the bat from stance to contact.
  for (let p = 0; p <= 0.85; p += 0.01) {
    const pose = sampleModelPose(p);
    assert.ok(len(pose.leadWrist, pose.trailWrist) < 0.09, `hands together @ p=${p.toFixed(2)}`);
  }

  // Published facts stay in sane coaching ranges.
  assert.ok(GHOST_FACTS.kneeAtContactDeg >= 150 && GHOST_FACTS.kneeAtContactDeg <= 180);
  assert.ok(GHOST_FACTS.strideTravelPct >= 18 && GHOST_FACTS.strideTravelPct <= 40);
  assert.ok(GHOST_FACTS.headDriftPct <= 8);
});

test('fit: ghost is scaled, grounded and synced to a righty swing', () => {
  const frames = syntheticSwing();
  const a = analyzeSwing(frames);
  assert.equal(a.ok, true);
  const g = buildGhost(a, frames);
  assert.equal(g.ok, true);

  // Phase mapping hits the player's detected key moments.
  const k = a.keyMoments;
  assert.equal(g.phaseOf(k.stance), 0);
  assert.ok(Math.abs(g.phaseOf(k.contact) - 0.80) < 1e-9);
  assert.equal(g.phaseOf(k.finish), 1.0);
  assert.equal(g.phaseOf(0), 0, 'holds stance before the swing');
  assert.equal(g.phaseOf(frames.length - 1), 1.0, 'holds finish after the swing');
  let prevP = -1;
  for (let i = 0; i < frames.length; i++) {
    const p = g.phaseOf(i);
    assert.ok(p >= prevP, `phase monotonic @ frame ${i}`);
    prevP = p;
  }

  // Ghost stance feet sit on the player's stance feet.
  const stanceLm = frames[k.stance].landmarks;
  const userAnkles = mid(stanceLm[27], stanceLm[28]);
  const pose0 = g.poseAt(k.stance);
  const ghostAnkles = mid(pose0.leadAnkle, pose0.trailAnkle);
  assert.ok(Math.abs(ghostAnkles.x - userAnkles.x) < 0.02, 'feet anchored in x');
  assert.ok(Math.abs(ghostAnkles.y - userAnkles.y) < 0.02, 'feet anchored in y');

  // Ghost is the player's height (nose-to-ankle == bodyH).
  const ghostH = ghostAnkles.y - pose0.nose.y;
  assert.ok(Math.abs(ghostH - a.bodyH) < a.bodyH * 0.02, `ghost height ${ghostH.toFixed(3)} ~ bodyH ${a.bodyH.toFixed(3)}`);

  // Righty strides toward +x: ghost moves the same way.
  const poseC = g.poseAt(k.contact);
  assert.ok(poseC.leadWrist.x > pose0.leadWrist.x, 'ghost swings toward +x');
  assert.equal(g.dir, 1);
});

test('fit: lefty (mirrored) swing flips the ghost', () => {
  const frames = mirroredSwing();
  const a = analyzeSwing(frames);
  assert.equal(a.ok, true);
  const g = buildGhost(a, frames);
  assert.equal(g.ok, true);
  assert.equal(g.dir, -1);
  const k = a.keyMoments;
  const poseC = g.poseAt(k.contact);
  const pose0 = g.poseAt(k.stance);
  assert.ok(poseC.leadWrist.x < pose0.leadWrist.x, 'ghost swings toward -x');
});

test('fit: refuses dishonest situations', () => {
  assert.equal(buildGhost(null, []).ok, false);
  assert.equal(buildGhost({ ok: false }, []).ok, false);
  const frames = syntheticSwing();
  const a = analyzeSwing(frames);
  assert.equal(buildGhost({ ...a, view: 'front' }, frames).ok, false, 'no 2D ghost on a front view');
  assert.equal(buildGhost({ ...a, view: 'front' }, frames).reason, 'front_view');
});

test('notes: only cite measured metrics, and always describe the model', () => {
  const frames = syntheticSwing();
  const a = analyzeSwing(frames);
  const notes = ghostPhaseNotes(a);
  assert.ok(notes.length >= 3);
  const measurable = new Set(
    a.metrics.filter((m) => m.confidence !== 'none' && m.band !== 'unknown').map((m) => m.label),
  );
  for (const n of notes) {
    assert.ok(n.model.length > 30, `model description for ${n.key}`);
    for (const y of n.yours) {
      const label = y.split(':')[0];
      assert.ok(measurable.has(label), `"${label}" was actually measured`);
    }
  }
  // Phases the analyzer didn't find don't get notes.
  const noStride = { ...a, keyMoments: { ...a.keyMoments, strideStart: null } };
  assert.ok(!ghostPhaseNotes(noStride).some((n) => n.key === 'strideStart'));
});
