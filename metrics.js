// Swing metrics — pure functions over pose landmark frames.
// Runs in the browser and in Node (unit tests). No DOM dependencies.
//
// Input frame shape: { t: seconds, landmarks: [33 x {x, y, visibility}] }
// Coordinates are MediaPipe normalized image coords (x,y in 0..1, y down).
//
// HONESTY CONTRACT: every metric carries a confidence level and the
// thresholds below are POC heuristics, not validated coaching standards.
// 3D quantities (attack angle, hip-shoulder separation velocity, weight
// transfer) are intentionally absent — they are not measurable from a
// single uncalibrated camera and we do not pretend otherwise.

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

// POC heuristic bands (fractions of body height unless noted).
export const BANDS = {
  headDrift: { good: 0.08, fair: 0.14 },          // max head travel, stance -> contact
  stride: { min: 0.10, low: 0.18, high: 0.55 },   // forward ankle travel
  frontKneeAtContact: { minFirm: 150 },            // degrees; firmer front leg ~ straighter
  spineTiltContact: { min: 8, max: 45 },           // degrees from vertical
  sequenceLeadMs: { min: 15, max: 400 },           // hips should peak before hands by >= min;
                                                   // a lead > max means we likely caught stride
                                                   // drift, not rotation — refuse to grade it
  minSwingFrames: 8,                               // frames inside the swing window
  minPersonHeight: 0.25,                           // person must fill >= 25% of frame height
  minVisibility: 0.5,
};

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

function smooth(values, win = 3) {
  const half = Math.floor(win / 2);
  return values.map((_, i) => {
    const s = Math.max(0, i - half), e = Math.min(values.length - 1, i + half);
    return avg(values.slice(s, e + 1));
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Angle ABC in degrees at vertex B.
export function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (m === 0) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}

// Lean of the shoulder-mid -> hip-mid line away from vertical, degrees.
export function spineTilt(lm) {
  const sm = mid(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]);
  const hm = mid(lm[LM.L_HIP], lm[LM.R_HIP]);
  return (Math.atan2(Math.abs(sm.x - hm.x), Math.abs(hm.y - sm.y)) * 180) / Math.PI;
}

function speeds(frames, getter) {
  const out = [0];
  for (let i = 1; i < frames.length; i++) {
    const dt = Math.max(1e-3, frames[i].t - frames[i - 1].t);
    out.push(dist(getter(frames[i].landmarks), getter(frames[i - 1].landmarks)) / dt);
  }
  return out;
}

function bodyHeightOf(frames) {
  const hs = frames.map((f) => {
    const ankleY = (f.landmarks[LM.L_ANKLE].y + f.landmarks[LM.R_ANKLE].y) / 2;
    return Math.abs(ankleY - f.landmarks[LM.NOSE].y);
  });
  return hs.slice().sort((a, b) => a - b)[Math.floor(hs.length / 2)] || 0;
}

function meanVisibility(frames) {
  const keys = Object.values(LM);
  return avg(frames.map((f) => avg(keys.map((k) => f.landmarks[k].visibility ?? 1))));
}

// "side" = camera looks down the shoulder line (shoulders overlap in x).
export function classifyView(lm, bodyH) {
  const spread = Math.abs(lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x) / (bodyH || 1);
  if (spread < 0.13) return 'side';
  if (spread < 0.24) return 'angled';
  return 'front';
}

export function analyzeSwing(frames) {
  if (!frames || frames.length < BANDS.minSwingFrames) {
    return { ok: false, reason: 'not_enough_frames', frameCount: frames?.length ?? 0 };
  }

  const bodyH = bodyHeightOf(frames);

  // wrist speed = mean of both wrists (bat occludes one hand at times)
  const wsRaw = (() => {
    const l = speeds(frames, (lm) => lm[LM.L_WRIST]);
    const r = speeds(frames, (lm) => lm[LM.R_WRIST]);
    return l.map((v, i) => (v + r[i]) / 2);
  })();
  const ws = smooth(wsRaw, 3);

  const contactIdx = ws.indexOf(Math.max(...ws));
  const peak = ws[contactIdx] || 0;
  if (peak * 0 !== 0 || peak <= 0) return { ok: false, reason: 'no_motion' };

  // Motion start: last frame before contact where wrists were quiet.
  let motionStart = 0;
  for (let i = contactIdx; i >= 0; i--) {
    if (ws[i] < peak * 0.12) { motionStart = i; break; }
  }

  // Stance baseline: median pose over the quiet frames before motion.
  const stanceFrames = frames.slice(0, Math.max(1, motionStart));
  const stance = stanceFrames[Math.floor(stanceFrames.length / 2)].landmarks;

  // Stride (front) foot = ankle that travels furthest in x before contact.
  const lTravel = Math.abs(frames[contactIdx].landmarks[LM.L_ANKLE].x - stance[LM.L_ANKLE].x);
  const rTravel = Math.abs(frames[contactIdx].landmarks[LM.R_ANKLE].x - stance[LM.R_ANKLE].x);
  const frontAnkle = lTravel >= rTravel ? LM.L_ANKLE : LM.R_ANKLE;
  const frontKnee = frontAnkle === LM.L_ANKLE ? LM.L_KNEE : LM.R_KNEE;
  const frontHip = frontAnkle === LM.L_ANKLE ? LM.L_HIP : LM.R_HIP;

  const ankleSpeed = smooth(speeds(frames, (lm) => lm[frontAnkle]), 3);
  const anklePeak = Math.max(...ankleSpeed.slice(0, contactIdx + 1));
  const ankleThresh = Math.max(anklePeak * 0.3, peak * 0.04);

  let strideStart = null, footPlant = null;
  let moved = false;
  for (let i = 0; i <= contactIdx; i++) {
    if (!moved && ankleSpeed[i] > ankleThresh) { moved = true; strideStart = i; }
    if (moved && footPlant === null && i > strideStart && ankleSpeed[i] < ankleThresh * 0.6) {
      footPlant = i;
    }
  }
  const strideTravel = footPlant !== null
    ? Math.abs(frames[footPlant].landmarks[frontAnkle].x - stance[frontAnkle].x) / bodyH
    : null;
  const strideDetected = footPlant !== null && strideTravel !== null && strideTravel > BANDS.stride.min;

  // Finish: wrists decelerate after contact.
  let finish = frames.length - 1;
  for (let i = contactIdx + 1; i < frames.length; i++) {
    if (ws[i] < peak * 0.25) { finish = i; break; }
  }

  // Head drift: nose travel from stance through contact.
  let headDrift = 0;
  const from = strideStart ?? motionStart;
  for (let i = from; i <= contactIdx; i++) {
    headDrift = Math.max(headDrift, dist(frames[i].landmarks[LM.NOSE], stance[LM.NOSE]));
  }
  headDrift /= bodyH;

  // Sequence proxy: hip-center speed peak should precede wrist speed peak.
  const hipSpeed = smooth(speeds(frames, (lm) => mid(lm[LM.L_HIP], lm[LM.R_HIP])), 3);
  const hipWindow = hipSpeed.slice(Math.max(0, from), contactIdx + 1);
  let sequenceLeadMs = null;
  if (hipWindow.length > 2) {
    const hipPeakIdx = Math.max(0, from) + hipWindow.indexOf(Math.max(...hipWindow));
    sequenceLeadMs = (frames[contactIdx].t - frames[hipPeakIdx].t) * 1000;
  }

  const contactLm = frames[contactIdx].landmarks;
  const kneeAngle = jointAngle(contactLm[frontHip], contactLm[frontKnee], contactLm[frontAnkle]);
  const tiltStance = spineTilt(stance);
  const tiltContact = spineTilt(contactLm);

  const view = classifyView(stance, bodyH);
  const visibility = meanVisibility(frames);
  const swingFrames = finish - from + 1;
  const swingDurMs = (frames[finish].t - frames[from].t) * 1000;
  const effFps = swingDurMs > 0 ? (swingFrames / swingDurMs) * 1000 : 0;

  const quality = scoreQuality({ bodyH, visibility, swingFrames, view });
  const metrics = buildMetrics({
    headDrift, strideDetected, strideTravel, kneeAngle, tiltStance, tiltContact,
    sequenceLeadMs, view, quality,
  });

  return {
    ok: true,
    bodyH,
    view,
    keyMoments: {
      stance: Math.floor(stanceFrames.length / 2),
      strideStart: strideStart ?? null,
      footPlant: footPlant ?? null,
      contact: contactIdx,
      finish,
    },
    quality: { ...quality, visibility, swingFrames, effFps: Math.round(effFps), swingDurMs: Math.round(swingDurMs) },
    metrics,
    feedback: buildFeedback(metrics),
    notMeasured: notMeasuredList(metrics, quality),
  };
}

function scoreQuality({ bodyH, visibility, swingFrames, view }) {
  const checks = {
    personSize: bodyH >= BANDS.minPersonHeight,
    visibility: visibility >= BANDS.minVisibility,
    sampling: swingFrames >= BANDS.minSwingFrames,
    samplingGood: swingFrames >= 20,
    viewKnown: view !== 'front' || true,
  };
  let score = 0;
  score += checks.personSize ? 30 : 10;
  score += checks.visibility ? 25 : 8;
  score += checks.samplingGood ? 35 : checks.sampling ? 18 : 5;
  score += 10; // base for a completed analysis
  const tips = [];
  if (!checks.personSize) tips.push('Get closer — the player should fill most of the frame.');
  if (!checks.visibility) tips.push('Make sure the whole body is visible and well lit.');
  if (!checks.samplingGood) tips.push('Record in slow-motion (120/240fps) — a swing lasts ~0.15s and slo-mo gives us many more frames to measure.');
  return { score: Math.min(100, score), checks, tips };
}

// confidence: 'high' | 'medium' | 'low' | 'none'
function conf(base, quality) {
  if (!quality.checks.sampling || !quality.checks.visibility) {
    return base === 'high' ? 'medium' : 'low';
  }
  if (!quality.checks.samplingGood && base === 'high') return 'medium';
  return base;
}

function buildMetrics(m) {
  const sideish = m.view === 'side' || m.view === 'angled';
  const out = [];

  out.push({
    id: 'headDrift',
    label: 'Head movement',
    value: m.headDrift,
    display: `${Math.round(m.headDrift * 100)}% of body height`,
    confidence: conf('high', m.quality),
    band: m.headDrift <= BANDS.headDrift.good ? 'good' : m.headDrift <= BANDS.headDrift.fair ? 'fair' : 'needs_work',
  });

  out.push({
    id: 'stride',
    label: 'Stride length',
    value: m.strideTravel,
    display: m.strideDetected ? `${Math.round(m.strideTravel * 100)}% of body height` : 'no clear stride detected',
    confidence: m.strideDetected ? conf(sideish ? 'high' : 'low', m.quality) : 'none',
    band: !m.strideDetected ? 'unknown'
      : m.strideTravel < BANDS.stride.low ? 'short'
      : m.strideTravel > BANDS.stride.high ? 'long' : 'good',
  });

  out.push({
    id: 'frontKnee',
    label: 'Front leg at contact',
    value: m.kneeAngle,
    display: Number.isFinite(m.kneeAngle) ? `${Math.round(m.kneeAngle)}° knee angle` : 'not measurable',
    confidence: Number.isFinite(m.kneeAngle) ? conf(sideish ? 'medium' : 'low', m.quality) : 'none',
    band: !Number.isFinite(m.kneeAngle) ? 'unknown' : m.kneeAngle >= BANDS.frontKneeAtContact.minFirm ? 'good' : 'soft',
  });

  out.push({
    id: 'posture',
    label: 'Posture (spine tilt)',
    value: m.tiltContact,
    display: `${Math.round(m.tiltStance)}° at stance → ${Math.round(m.tiltContact)}° at contact`,
    confidence: conf(sideish ? 'medium' : 'low', m.quality),
    band: m.tiltContact >= BANDS.spineTiltContact.min && m.tiltContact <= BANDS.spineTiltContact.max ? 'good' : 'check',
  });

  const seqUnmeasurable = m.sequenceLeadMs === null || m.sequenceLeadMs > BANDS.sequenceLeadMs.max;
  out.push({
    id: 'sequence',
    label: 'Swing sequence (hips before hands)',
    value: m.sequenceLeadMs,
    display: m.sequenceLeadMs === null ? 'not measurable'
      : m.sequenceLeadMs > BANDS.sequenceLeadMs.max ? 'could not isolate hip rotation from stride'
      : m.sequenceLeadMs >= BANDS.sequenceLeadMs.min ? `hips fired ~${Math.round(m.sequenceLeadMs)}ms before hands`
      : 'hips and hands fired together',
    confidence: seqUnmeasurable ? 'none' : conf('medium', m.quality),
    band: seqUnmeasurable ? 'unknown' : m.sequenceLeadMs >= BANDS.sequenceLeadMs.min ? 'good' : 'check',
  });

  return out;
}

const FEEDBACK_COPY = {
  headDrift: {
    good: ['Quiet head', 'Your head stays remarkably still through the swing — that keeps your eyes locked on the ball and is one of the strongest fundamentals a hitter can have.'],
    fair: ['Some head movement', 'Your head drifts a little during the stride. Try to feel like your nose stays over the same spot until contact — a quieter head means better pitch tracking.'],
    needs_work: ['Head moving a lot', 'Your head travels quite a bit before contact, which makes it harder to track the pitch. Drill: take slow dry swings keeping your eyes on a fixed point.'],
  },
  stride: {
    good: ['Balanced stride', 'Your stride length is in a healthy range — you’re getting into a strong launch position without overreaching.'],
    short: ['Short stride', 'Your stride is on the short side. That can be fine (plenty of pros stride short), but make sure you’re still getting your weight moving toward the pitcher.'],
    long: ['Long stride', 'Your stride is long, which can pull your head and balance forward. Try a slightly shorter stride and feel your back hip drive instead.'],
  },
  frontKnee: {
    good: ['Firm front side', 'Your front leg firms up at contact — that’s what lets the hips rotate hard and transfers energy into the bat.'],
    soft: ['Soft front knee', 'Your front knee stays bent at contact, which leaks power. Drill: pause at contact in slow swings and feel the front leg straighten as the hips turn.'],
  },
  posture: {
    good: ['Good posture', 'Your spine angle stays athletic from stance to contact.'],
    check: ['Posture changes', 'Your spine angle changes noticeably during the swing — worth checking with video whether you’re standing up or collapsing as you swing.'],
  },
  sequence: {
    good: ['Great sequencing', 'Your hips start the swing before your hands — that’s the kinematic order good hitters share, and it’s where bat speed comes from.'],
    check: ['Hands a bit early', 'Your hands and hips seem to fire at nearly the same time. Feel the back hip start the swing and let the hands "get pulled" — drill: slow swings pausing right after hip turn.'],
  },
};

function buildFeedback(metrics) {
  const strengths = [], improvements = [];
  const priority = ['headDrift', 'sequence', 'frontKnee', 'stride', 'posture'];
  for (const id of priority) {
    const metric = metrics.find((x) => x.id === id);
    if (!metric || metric.confidence === 'none' || metric.band === 'unknown') continue;
    const copy = FEEDBACK_COPY[id]?.[metric.band];
    if (!copy) continue;
    const item = { id, title: copy[0], detail: copy[1], measured: metric.display, confidence: metric.confidence };
    if (metric.band === 'good') strengths.push(item);
    else improvements.push(item);
  }
  return { strengths: strengths.slice(0, 3), improvements: improvements.slice(0, 3) };
}

function notMeasuredList(metrics, quality) {
  const items = [];
  for (const metric of metrics) {
    if (metric.confidence === 'none' || metric.band === 'unknown') {
      items.push({ label: metric.label, reason: 'Could not be measured reliably from this video.' });
    } else if (metric.confidence === 'low') {
      items.push({ label: metric.label, reason: 'Measured, but with low confidence from this camera angle/quality — treat as a rough indication.' });
    }
  }
  items.push({
    label: 'Bat path & attack angle, hip-shoulder separation speed, weight transfer',
    reason: 'These need 3D capture (multiple cameras or sensors). A single phone camera cannot measure them honestly, so this analysis doesn’t guess at them.',
  });
  return items;
}
