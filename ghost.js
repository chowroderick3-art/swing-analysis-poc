// Swing Ghost — a model swing skeleton drawn over the player's own video.
// Pure functions over pose landmark frames; no DOM access at import time
// (drawGhost only touches the canvas it is handed), so everything here is
// unit-testable in Node.
//
// HONESTY CONTRACT (same spirit as metrics.js):
// - The ghost is a SYNTHESIZED model swing built from standard coaching
//   checkpoints (quiet head, hands stay back, firm front side, hips before
//   hands, balanced finish) — it is NOT motion capture of a specific pro,
//   and the UI must say so.
// - It is scaled to the player's measured body height, anchored to their
//   stance foot position, and mirrored to their handedness — but it is a
//   2D side-view model, so it is only offered for side/angled videos.
// - It is phase-synced to the player's own detected key moments, which
//   means it shows SHAPE differences, never timing differences.
//
// Model space: x toward the pitcher (+), y UP, ground at y = 0, full body
// height = 1. Image space is MediaPipe-normalized (y down), handled by the
// transform inside buildGhost.

import { LM, jointAngle } from './metrics.js';

/* ---------- the model swing: authored keyframes ---------- */

// Segment lengths (fractions of body height, standard anthropometry).
const SEG = { torso: 0.282, neck: 0.114, upperArm: 0.165, forearm: 0.165, thigh: 0.245, shank: 0.235 };

// Authored points per keyframe. Elbows and knees are NOT authored — they
// are solved by two-bone IK at module load (knees bend toward the pitcher,
// elbows take the lower solution), which keeps limb lengths honest.
// Feet and shoulder/hip widths are authored freely: they encode the 3D
// rotation of the body as it projects onto the side view.
const KEYS = [
  { p: 0.00, name: 'stance', pose: {
    nose: [0.000, 0.868],
    leadShoulder: [0.005, 0.756], trailShoulder: [-0.045, 0.756],
    leadWrist: [-0.125, 0.775], trailWrist: [-0.135, 0.795],
    leadHip: [0.025, 0.475], trailHip: [-0.025, 0.475],
    leadAnkle: [0.140, 0.040], trailAnkle: [-0.140, 0.040],
    leadToe: [0.180, 0.000], trailToe: [-0.100, 0.000],
  } },
  { p: 0.12, name: 'load', pose: {
    nose: [-0.015, 0.866],
    leadShoulder: [-0.015, 0.754], trailShoulder: [-0.065, 0.754],
    leadWrist: [-0.150, 0.778], trailWrist: [-0.160, 0.798],
    leadHip: [0.005, 0.475], trailHip: [-0.045, 0.475],
    leadAnkle: [0.140, 0.045], trailAnkle: [-0.140, 0.040],
    leadToe: [0.175, 0.005], trailToe: [-0.100, 0.000],
  } },
  { p: 0.22, name: 'strideBegin', pose: {
    nose: [-0.010, 0.865],
    leadShoulder: [-0.010, 0.752], trailShoulder: [-0.060, 0.752],
    leadWrist: [-0.145, 0.775], trailWrist: [-0.155, 0.795],
    leadHip: [0.010, 0.473], trailHip: [-0.040, 0.473],
    leadAnkle: [0.160, 0.090], trailAnkle: [-0.140, 0.040],
    leadToe: [0.200, 0.050], trailToe: [-0.100, 0.000],
  } },
  { p: 0.38, name: 'strideFlight', pose: {
    nose: [0.000, 0.862],
    leadShoulder: [0.000, 0.748], trailShoulder: [-0.050, 0.748],
    leadWrist: [-0.135, 0.772], trailWrist: [-0.145, 0.792],
    leadHip: [0.030, 0.468], trailHip: [-0.020, 0.468],
    leadAnkle: [0.270, 0.100], trailAnkle: [-0.140, 0.040],
    leadToe: [0.310, 0.060], trailToe: [-0.100, 0.000],
  } },
  { p: 0.55, name: 'footPlant', pose: {
    nose: [0.040, 0.825],
    leadShoulder: [0.055, 0.712], trailShoulder: [-0.005, 0.708],
    leadWrist: [-0.100, 0.745], trailWrist: [-0.110, 0.768],
    leadHip: [0.105, 0.432], trailHip: [0.035, 0.428],
    leadAnkle: [0.360, 0.040], trailAnkle: [-0.140, 0.040],
    leadToe: [0.405, 0.005], trailToe: [-0.100, 0.000],
  } },
  { p: 0.68, name: 'hipFire', pose: {
    nose: [0.045, 0.832],
    leadShoulder: [0.060, 0.720], trailShoulder: [0.000, 0.720],
    leadWrist: [0.100, 0.600], trailWrist: [0.085, 0.615],
    leadHip: [0.130, 0.443], trailHip: [0.040, 0.437],
    leadAnkle: [0.360, 0.040], trailAnkle: [-0.120, 0.090],
    leadToe: [0.405, 0.005], trailToe: [-0.085, 0.010],
  } },
  { p: 0.80, name: 'contact', pose: {
    nose: [0.050, 0.850],
    leadShoulder: [0.110, 0.742], trailShoulder: [0.045, 0.738],
    leadWrist: [0.345, 0.565], trailWrist: [0.325, 0.558],
    leadHip: [0.140, 0.462], trailHip: [0.060, 0.458],
    leadAnkle: [0.360, 0.040], trailAnkle: [-0.040, 0.105],
    leadToe: [0.405, 0.005], trailToe: [-0.065, 0.010],
  } },
  { p: 0.88, name: 'extension', pose: {
    nose: [0.055, 0.853],
    leadShoulder: [0.110, 0.747], trailShoulder: [0.055, 0.743],
    leadWrist: [0.385, 0.645], trailWrist: [0.375, 0.638],
    leadHip: [0.145, 0.465], trailHip: [0.065, 0.461],
    leadAnkle: [0.360, 0.040], trailAnkle: [-0.020, 0.115],
    leadToe: [0.405, 0.005], trailToe: [-0.050, 0.015],
  } },
  { p: 1.00, name: 'finish', pose: {
    nose: [0.055, 0.855],
    leadShoulder: [0.100, 0.752], trailShoulder: [0.050, 0.748],
    leadWrist: [-0.020, 0.775], trailWrist: [-0.045, 0.788],
    leadHip: [0.145, 0.465], trailHip: [0.065, 0.461],
    leadAnkle: [0.360, 0.040], trailAnkle: [-0.010, 0.130],
    leadToe: [0.405, 0.005], trailToe: [-0.045, 0.020],
  } },
];

const v = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const toPt = ([x, y]) => ({ x, y });

// Two-bone IK: place the middle joint (elbow/knee) given root, target and
// segment lengths. `pick` chooses between the two mirror solutions.
// If the target is out of reach the limb simply straightens toward it.
function ik(root, target, l1, l2, pick) {
  let dx = target.x - root.x, dy = target.y - root.y;
  let d = Math.hypot(dx, dy);
  if (d < 1e-9) { dx = 0; dy = -1; d = 1e-9; }
  if (d >= (l1 + l2) * 0.9999) {
    return { x: root.x + (dx / d) * l1, y: root.y + (dy / d) * l1 };
  }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mx = root.x + (dx / d) * a, my = root.y + (dy / d) * a;
  const px = -dy / d, py = dx / d;
  const e1 = { x: mx + px * h, y: my + py * h };
  const e2 = { x: mx - px * h, y: my - py * h };
  return pick(e1, e2);
}

const pickKnee = (e1, e2) => (e1.x >= e2.x ? e1 : e2);   // knees bend toward the pitcher
const pickElbow = (e1, e2) => (e1.y <= e2.y ? e1 : e2);  // elbows hang low (model y-up)

// Solve elbows/knees for every authored keyframe once, at module load.
function solveKey(pose) {
  const P = Object.fromEntries(Object.entries(pose).map(([k, xy]) => [k, toPt(xy)]));
  for (const side of ['lead', 'trail']) {
    P[`${side}Elbow`] = ik(P[`${side}Shoulder`], P[`${side}Wrist`], SEG.upperArm, SEG.forearm, pickElbow);
    P[`${side}Knee`] = ik(P[`${side}Hip`], P[`${side}Ankle`], SEG.thigh, SEG.shank, pickKnee);
  }
  return P;
}

export const GHOST_KEYS = KEYS.map((k) => ({ p: k.p, name: k.name, pose: solveKey(k.pose) }));
export const GHOST_POINTS = Object.keys(GHOST_KEYS[0].pose);

// Nose-to-ankle height of the model at stance — the quantity that
// corresponds to analysis.bodyH on the player, used for scaling.
const stancePose = GHOST_KEYS[0].pose;
export const MODEL_BODYH = stancePose.nose.y - mid(stancePose.leadAnkle, stancePose.trailAnkle).y;

/* ---------- sampling: Catmull-Rom between keyframes + length cleanup ---------- */

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// Re-point `child` so the segment from `parent` has exactly `target` length,
// preserving the interpolated direction.
function enforceLen(parent, child, target) {
  const d = len(parent, child) || 1e-9;
  return { x: parent.x + ((child.x - parent.x) / d) * target, y: parent.y + ((child.y - parent.y) / d) * target };
}

// Sample the model swing at phase p in [0, 1]. Returns model-space points.
export function sampleModelPose(p) {
  p = Math.max(0, Math.min(1, p));
  let seg = 0;
  while (seg < GHOST_KEYS.length - 2 && p > GHOST_KEYS[seg + 1].p) seg++;
  const k0 = GHOST_KEYS[Math.max(0, seg - 1)].pose;
  const k1 = GHOST_KEYS[seg].pose;
  const k2 = GHOST_KEYS[seg + 1].pose;
  const k3 = GHOST_KEYS[Math.min(GHOST_KEYS.length - 1, seg + 2)].pose;
  const t = (p - GHOST_KEYS[seg].p) / (GHOST_KEYS[seg + 1].p - GHOST_KEYS[seg].p || 1);

  const out = {};
  for (const name of GHOST_POINTS) {
    out[name] = {
      x: catmullRom(k0[name].x, k1[name].x, k2[name].x, k3[name].x, t),
      y: catmullRom(k0[name].y, k1[name].y, k2[name].y, k3[name].y, t),
    };
  }

  // Interpolation between valid keyframes can still shrink rotating
  // segments; pin the structural lengths back to canon. Wrists, ankles,
  // toes and widths stay as interpolated (feet/widths encode 3D rotation).
  const hipC = mid(out.leadHip, out.trailHip);
  const shoulderC = mid(out.leadShoulder, out.trailShoulder);
  const fixedSC = enforceLen(hipC, shoulderC, SEG.torso);
  const dx = fixedSC.x - shoulderC.x, dy = fixedSC.y - shoulderC.y;
  for (const nm of ['leadShoulder', 'trailShoulder', 'nose']) { out[nm].x += dx; out[nm].y += dy; }
  out.nose = enforceLen(fixedSC, out.nose, SEG.neck);
  for (const side of ['lead', 'trail']) {
    out[`${side}Elbow`].x += dx; out[`${side}Elbow`].y += dy;
    out[`${side}Elbow`] = enforceLen(out[`${side}Shoulder`], out[`${side}Elbow`], SEG.upperArm);
    out[`${side}Wrist`] = enforceLen(out[`${side}Elbow`], out[`${side}Wrist`], SEG.forearm);
    // Knees re-pinned to the thigh; ankles stay authored so feet never
    // leave the ground (the shank may breathe slightly mid-interpolation).
    out[`${side}Knee`] = enforceLen(out[`${side}Hip`], out[`${side}Knee`], SEG.thigh);
  }
  return out;
}

/* ---------- model facts (used by tests and the phase notes) ---------- */

function modelFacts() {
  const stance = GHOST_KEYS.find((k) => k.name === 'stance').pose;
  const plant = GHOST_KEYS.find((k) => k.name === 'footPlant').pose;
  const contact = GHOST_KEYS.find((k) => k.name === 'contact').pose;
  const strideTravel = (plant.leadAnkle.x - stance.leadAnkle.x) / MODEL_BODYH;
  const kneeAtContact = jointAngle(contact.leadHip, contact.leadKnee, contact.leadAnkle);
  let headDrift = 0;
  for (const k of GHOST_KEYS) {
    if (k.p <= 0.80) headDrift = Math.max(headDrift, len(k.pose.nose, stance.nose));
  }
  return {
    strideTravelPct: Math.round(strideTravel * 100),
    kneeAtContactDeg: Math.round(kneeAtContact),
    headDriftPct: Math.round((headDrift / MODEL_BODYH) * 100),
  };
}
export const GHOST_FACTS = modelFacts();

/* ---------- fitting the ghost onto the player's video ---------- */

// Phase values the player's detected key moments map onto.
const ANCHOR_PHASE = { stance: 0.0, strideStart: 0.22, footPlant: 0.55, contact: 0.80, finish: 1.0 };

export function buildGhost(analysis, frames, aspect = 1) {
  if (!analysis?.ok) return { ok: false, reason: 'no_analysis' };
  if (analysis.view === 'front') return { ok: false, reason: 'front_view' };
  const k = analysis.keyMoments;
  if (k.stance == null || k.contact == null || k.finish == null) return { ok: false, reason: 'missing_moments' };

  // Anchors: (frame index -> phase), strictly increasing in both.
  const anchors = [];
  for (const [name, phase] of Object.entries(ANCHOR_PHASE)) {
    const idx = k[name];
    if (idx == null) continue;
    if (anchors.length && (idx <= anchors[anchors.length - 1][0] || phase <= anchors[anchors.length - 1][1])) continue;
    anchors.push([idx, phase]);
  }
  if (anchors.length < 2) return { ok: false, reason: 'missing_moments' };

  const phaseOf = (i) => {
    if (i <= anchors[0][0]) return anchors[0][1];
    if (i >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
    let s = 0;
    while (s < anchors.length - 2 && i > anchors[s + 1][0]) s++;
    const [i0, p0] = anchors[s], [i1, p1] = anchors[s + 1];
    return p0 + ((i - i0) / (i1 - i0 || 1)) * (p1 - p0);
  };

  // Handedness: which way does the player move toward the pitcher?
  const stanceLm = frames[k.stance].landmarks;
  const contactLm = frames[k.contact].landmarks;
  const tL = contactLm[LM.L_ANKLE].x - stanceLm[LM.L_ANKLE].x;
  const tR = contactLm[LM.R_ANKLE].x - stanceLm[LM.R_ANKLE].x;
  let travel = Math.abs(tL) >= Math.abs(tR) ? tL : tR;
  if (Math.abs(travel) < 0.015) {
    const wristMid = (lm) => (lm[LM.L_WRIST].x + lm[LM.R_WRIST].x) / 2;
    travel = wristMid(contactLm) - wristMid(stanceLm);
  }
  const dir = travel >= 0 ? 1 : -1;

  // Anchor the ghost's stance feet on the player's stance feet, scale the
  // model so its nose-to-ankle height equals the player's measured bodyH.
  // `aspect` (videoHeight/videoWidth) keeps the model isotropic in PIXELS
  // even though landmark coordinates are normalized per-axis.
  const anchorX = (stanceLm[LM.L_ANKLE].x + stanceLm[LM.R_ANKLE].x) / 2;
  const anchorY = (stanceLm[LM.L_ANKLE].y + stanceLm[LM.R_ANKLE].y) / 2;
  const scale = analysis.bodyH / MODEL_BODYH;
  const modelAnkleY = mid(stancePose.leadAnkle, stancePose.trailAnkle).y;

  const cache = new Map();
  const poseAt = (i) => {
    if (cache.has(i)) return cache.get(i);
    const m = sampleModelPose(phaseOf(i));
    const out = {};
    for (const name of GHOST_POINTS) {
      out[name] = {
        x: anchorX + dir * m[name].x * scale * aspect,
        y: anchorY - (m[name].y - modelAnkleY) * scale,
      };
    }
    cache.set(i, out);
    return out;
  };

  return { ok: true, poseAt, phaseOf, dir, anchors };
}

/* ---------- per-phase notes: model vs. what we measured on the player ---------- */

// Notes only ever cite metrics that were actually measured (confidence not
// 'none'); the model side is always available because we computed it.
export function ghostPhaseNotes(analysis) {
  const m = Object.fromEntries((analysis?.metrics ?? []).map((x) => [x.id, x]));
  const measured = (id) => m[id] && m[id].confidence !== 'none' && m[id].band !== 'unknown';
  const yoursOf = (...ids) => ids.filter(measured).map((id) => `${m[id].label}: ${m[id].display}`);
  const F = GHOST_FACTS;
  const notes = [
    {
      key: 'stance', label: 'Stance',
      model: 'Athletic base: feet just past shoulder width, knees flexed, weight centered, hands relaxed up near the back shoulder, eyes level toward the pitcher.',
      yours: yoursOf('posture'),
    },
    {
      key: 'strideStart', label: 'Stride',
      model: `A controlled stride — the ghost's front foot travels about ${F.strideTravelPct}% of body height — while the hands STAY BACK by the rear shoulder.`,
      yours: yoursOf('stride'),
    },
    {
      key: 'footPlant', label: 'Foot plant',
      model: 'The front foot lands firm and slightly closed while the hands are still back. That stretch between the lower and upper body is where bat speed comes from.',
      yours: yoursOf('sequence'),
    },
    {
      key: 'contact', label: 'Contact',
      model: `Front leg posted up firm (~${F.kneeAtContactDeg}° at the knee), hips already open, arms extending through the ball — and the head has moved only ~${F.headDriftPct}% of body height since stance.`,
      yours: yoursOf('frontKnee', 'headDrift'),
    },
    {
      key: 'finish', label: 'Finish',
      model: 'Balanced over a firm front leg, hands finishing high, eyes still where contact happened. If you can hold this for two seconds, the swing was under control.',
      yours: [],
    },
  ];
  const km = analysis?.keyMoments ?? {};
  return notes.filter((n) => km[n.key] != null);
}

/* ---------- drawing ---------- */

const BONES = [
  ['trailAnkle', 'trailKnee'], ['trailKnee', 'trailHip'],
  ['leadAnkle', 'leadKnee'], ['leadKnee', 'leadHip'],
  ['leadHip', 'trailHip'], ['leadShoulder', 'trailShoulder'],
  ['leadHip', 'leadShoulder'], ['trailHip', 'trailShoulder'],
  ['leadShoulder', 'leadElbow'], ['leadElbow', 'leadWrist'],
  ['trailShoulder', 'trailElbow'], ['trailElbow', 'trailWrist'],
  ['leadAnkle', 'leadToe'], ['trailAnkle', 'trailToe'],
];

// Draw the ghost pose (image-normalized coords) on a canvas that has
// already been sized by the caller (drawSkeleton sizes it per frame).
export function drawGhost(canvas, pose, { alpha = 0.85 } = {}) {
  if (!pose || !canvas.width) return;
  const ctx = canvas.getContext('2d');
  const px = (p) => [p.x * canvas.width, p.y * canvas.height];
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = Math.max(3, canvas.width / 170);
  ctx.shadowColor = 'rgba(190,225,255,0.9)';
  ctx.shadowBlur = Math.max(4, canvas.width / 140);
  for (const [a, b] of BONES) {
    const [ax, ay] = px(pose[a]); const [bx, by] = px(pose[b]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  // Head: neck line + a circle, so the ghost reads as a figure.
  const sc = mid(pose.leadShoulder, pose.trailShoulder);
  const [nx, ny] = px(pose.nose);
  const [sx, sy] = px(sc);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(nx, ny); ctx.stroke();
  const r = Math.hypot(nx - sx, ny - sy) * 0.52;
  ctx.beginPath(); ctx.arc(nx, ny, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
