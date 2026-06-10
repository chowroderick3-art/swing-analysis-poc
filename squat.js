// Squat pack: rep segmentation + per-rep metrics over pose landmark frames.
// Pure functions (no DOM) — unit-tested in Node like metrics.js.
//
// Same honesty contract as the baseball pack: every metric carries a
// confidence level, thresholds are POC heuristics (squat styles vary —
// high-bar/low-bar/front squats legitimately look different), and anything
// requiring 3D or load data (bar path in 3D, weight on the bar, force
// output) is declared unmeasurable rather than guessed.
import { LM, jointAngle, spineTilt, classifyView } from './metrics.js';

export const SQUAT_BANDS = {
  minRepDrop: 0.10,        // hip must drop >= 10% of body height to count as a rep
  parallelSlack: 0.02,     // hip within 2% bodyH above knee still counts "at parallel"
  goodBackTiltMax: 65,     // degrees from vertical at the bottom; beyond = folding over
  fastDescentS: 0.45,      // descent quicker than this = "control the drop"
  fatigueDropoff: 0.15,    // last-rep depth >=15% shallower than best = fatigue signal
  hipsFirstTiltGain: 7,    // degrees of extra forward tilt during early ascent = hips shot up
  kneeCaveRatio: 0.85,     // front view: knee width / ankle width below this = caving in
  minFramesPerRep: 5,
  minVisibility: 0.5,
  minPersonHeight: 0.25,
};

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;

function smooth(values, win = 5) {
  const half = Math.floor(win / 2);
  return values.map((_, i) => {
    const s = Math.max(0, i - half), e = Math.min(values.length - 1, i + half);
    return avg(values.slice(s, e + 1));
  });
}

const hipY = (lm) => (lm[LM.L_HIP].y + lm[LM.R_HIP].y) / 2;
const kneeY = (lm) => (lm[LM.L_KNEE].y + lm[LM.R_KNEE].y) / 2;

function bodyHeightOf(frames) {
  // nose-to-ankle at the most upright (smallest hipY) moments
  const ranked = frames.slice().sort((a, b) => hipY(a.landmarks) - hipY(b.landmarks));
  const standing = ranked.slice(0, Math.max(1, Math.floor(frames.length * 0.2)));
  return median(standing.map((f) => {
    const ankleY = (f.landmarks[LM.L_ANKLE].y + f.landmarks[LM.R_ANKLE].y) / 2;
    return Math.abs(ankleY - f.landmarks[LM.NOSE].y);
  }));
}

// Segment a clip into reps from the hip-height trace: a rep is an excursion
// below standing height that exceeds minRepDrop and returns most of the way.
export function segmentReps(frames, bodyH) {
  const ys = smooth(frames.map((f) => hipY(f.landmarks)), 5);
  const standingY = median(ys.slice().sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(ys.length * 0.2))));
  const drop = ys.map((y) => (y - standingY) / bodyH);   // + = lower than standing

  const reps = [];
  let inRep = false, startIdx = 0, bottomIdx = 0, bottomDrop = 0;
  const enter = SQUAT_BANDS.minRepDrop * 0.5;
  for (let i = 0; i < drop.length; i++) {
    if (!inRep && drop[i] > enter) {
      inRep = true; startIdx = Math.max(0, i - 1); bottomIdx = i; bottomDrop = drop[i];
    } else if (inRep) {
      if (drop[i] > bottomDrop) { bottomDrop = drop[i]; bottomIdx = i; }
      const recovered = drop[i] < Math.max(enter * 0.8, bottomDrop * 0.3);
      if (recovered || i === drop.length - 1) {
        if (bottomDrop >= SQUAT_BANDS.minRepDrop && (bottomIdx - startIdx) >= 1 && (i - startIdx) >= SQUAT_BANDS.minFramesPerRep) {
          reps.push({ startIdx, bottomIdx, endIdx: i, depthDrop: bottomDrop });
        }
        inRep = false;
      }
    }
  }
  return { reps, standingY };
}

function repMetrics(frames, rep, bodyH, view) {
  const bottom = frames[rep.bottomIdx].landmarks;
  const hipVsKnee = (hipY(bottom) - kneeY(bottom)) / bodyH;  // + = hip below knee
  const depthBand = hipVsKnee >= 0 ? 'deep'
    : hipVsKnee >= -SQUAT_BANDS.parallelSlack ? 'parallel'
    : 'shallow';
  const backTilt = spineTilt(bottom);
  const kneeAngle = jointAngle(bottom[LM.L_HIP], bottom[LM.L_KNEE], bottom[LM.L_ANKLE]);
  const descentS = frames[rep.bottomIdx].t - frames[rep.startIdx].t;
  const ascentS = frames[rep.endIdx].t - frames[rep.bottomIdx].t;

  // "Hips shooting up first" (good-morning fault): if the torso tips
  // further forward during the first half of the ascent, the hips are
  // rising faster than the shoulders. Side view only.
  let hipsFirst = false;
  if (view !== 'front') {
    const midAscent = Math.min(rep.endIdx, rep.bottomIdx + Math.max(1, Math.floor((rep.endIdx - rep.bottomIdx) / 2)));
    let maxTiltAscent = backTilt;
    for (let i = rep.bottomIdx; i <= midAscent; i++) {
      maxTiltAscent = Math.max(maxTiltAscent, spineTilt(frames[i].landmarks));
    }
    hipsFirst = maxTiltAscent - backTilt > SQUAT_BANDS.hipsFirstTiltGain;
  }

  // Knee cave (valgus): front view only — knees drifting inside the ankles
  // at the bottom of the rep.
  let kneeCaveRatio = null;
  if (view === 'front') {
    const kneeW = Math.abs(bottom[LM.L_KNEE].x - bottom[LM.R_KNEE].x);
    const ankleW = Math.abs(bottom[LM.L_ANKLE].x - bottom[LM.R_ANKLE].x);
    kneeCaveRatio = ankleW > 0.01 ? kneeW / ankleW : null;
  }

  return {
    depthBand,
    hipVsKnee,
    depthDrop: rep.depthDrop,
    backTilt,
    kneeAngle,
    descentS,
    ascentS,
    hipsFirst,
    kneeCaveRatio,
    bottomIdx: rep.bottomIdx,
    startIdx: rep.startIdx,
    endIdx: rep.endIdx,
  };
}

// Per-rep score over the parts measurable from this view; normalized so an
// unmeasurable part shrinks the scorecard instead of penalizing (same rule
// as the baseball Swing Score).
export function scoreRep(rep, view) {
  const parts = [];
  if (view !== 'front') {
    parts.push(['depth', rep.depthBand === 'deep' ? 1 : rep.depthBand === 'parallel' ? 0.75 : 0.3, 40]);
    parts.push(['lean', rep.backTilt <= SQUAT_BANDS.goodBackTiltMax ? 1 : 0.4, 20]);
    parts.push(['rise', rep.hipsFirst ? 0.4 : 1, 20]);
  } else if (rep.kneeCaveRatio !== null) {
    parts.push(['knees', rep.kneeCaveRatio >= SQUAT_BANDS.kneeCaveRatio ? 1 : 0.4, 50]);
  }
  parts.push(['tempo', rep.descentS >= SQUAT_BANDS.fastDescentS ? 1 : 0.4, 20]);
  const possible = parts.reduce((s, [, , w]) => s + w, 0);
  const earned = parts.reduce((s, [, c, w]) => s + c * w, 0);
  return possible ? Math.round((earned / possible) * 100) : null;
}

export function gradeOf(score) {
  return score >= 90 ? 'A' : score >= 80 ? 'B+' : score >= 70 ? 'B' : score >= 60 ? 'C+' : score >= 50 ? 'C' : 'Keep working';
}

function meanVisibility(frames) {
  const keys = Object.values(LM);
  return avg(frames.map((f) => avg(keys.map((k) => f.landmarks[k].visibility ?? 1))));
}

export function analyzeSquat(frames) {
  if (!frames || frames.length < 20) {
    return { ok: false, reason: 'not_enough_frames', frameCount: frames?.length ?? 0 };
  }
  const bodyH = bodyHeightOf(frames);
  if (!bodyH) return { ok: false, reason: 'no_person' };

  const { reps: rawReps } = segmentReps(frames, bodyH);
  if (rawReps.length === 0) return { ok: false, reason: 'no_reps' };

  const view = classifyView(frames[0].landmarks, bodyH);
  const reps = rawReps.map((r) => repMetrics(frames, r, bodyH, view));
  const visibility = meanVisibility(frames);
  const sideish = view === 'side' || view === 'angled';

  // Aggregates
  const depths = reps.map((r) => r.depthDrop);
  const bestDepth = Math.max(...depths);
  const lastDepth = depths[depths.length - 1];
  const deepCount = reps.filter((r) => r.depthBand !== 'shallow').length;
  const tiltMax = Math.max(...reps.map((r) => r.backTilt));
  const fastReps = reps.filter((r) => r.descentS > 0 && r.descentS < SQUAT_BANDS.fastDescentS).length;
  const fatigued = reps.length >= 3 && lastDepth <= bestDepth * (1 - SQUAT_BANDS.fatigueDropoff);
  const hipsFirstReps = reps.filter((r) => r.hipsFirst).length;
  const cavingReps = reps.filter((r) => r.kneeCaveRatio !== null && r.kneeCaveRatio < SQUAT_BANDS.kneeCaveRatio).length;
  const repScores = reps.map((r) => scoreRep(r, view));
  const setScore = repScores.some((x) => x === null) || repScores.length === 0
    ? null
    : Math.round(repScores.reduce((a, b) => a + b, 0) / repScores.length);
  const bestRepIdx = repScores.indexOf(Math.max(...repScores.filter((x) => x !== null)));
  const depthConsistency = depths.length > 1
    ? 1 - (Math.max(...depths) - Math.min(...depths)) / (bestDepth || 1)
    : 1;

  const quality = {
    checks: {
      personSize: bodyH >= SQUAT_BANDS.minPersonHeight,
      visibility: visibility >= SQUAT_BANDS.minVisibility,
      sideView: sideish,
      sampling: frames.length / (frames[frames.length - 1].t - frames[0].t || 1) >= 8,
    },
    tips: [],
  };
  if (!quality.checks.personSize) quality.tips.push('Get closer — the lifter should fill most of the frame.');
  if (!quality.checks.sideView) quality.tips.push('From the front we can check knee tracking but not depth or back angle — film from the side for the full analysis.');
  if (!quality.checks.visibility) quality.tips.push('Make sure the whole body stays visible, including the feet.');
  quality.score = Math.min(100,
    (quality.checks.personSize ? 30 : 10) + (quality.checks.visibility ? 25 : 8) +
    (quality.checks.sideView ? 30 : 10) + (quality.checks.sampling ? 15 : 6));

  const conf = (base) => {
    if (!quality.checks.visibility || !quality.checks.personSize) return base === 'high' ? 'medium' : 'low';
    return base;
  };

  const metrics = [];
  if (sideish) {
    metrics.push(
      {
        id: 'depth',
        label: 'Depth',
        display: `${deepCount} of ${reps.length} reps at/below parallel`,
        band: deepCount === reps.length ? 'good' : deepCount >= reps.length / 2 ? 'mixed' : 'shallow',
        confidence: conf('high'),
      },
      {
        id: 'backAngle',
        label: 'Back angle (max lean at bottom)',
        display: `${Math.round(tiltMax)}° from vertical`,
        band: tiltMax <= SQUAT_BANDS.goodBackTiltMax ? 'good' : 'folded',
        confidence: conf('medium'),
      },
      {
        id: 'hipsFirst',
        label: 'Hip-shoulder rise (out of the hole)',
        display: hipsFirstReps === 0 ? 'hips and chest rise together' : `hips shot up first on ${hipsFirstReps} of ${reps.length} reps`,
        band: hipsFirstReps === 0 ? 'good' : 'fault',
        confidence: conf('medium'),
      },
    );
  } else {
    metrics.push({
      id: 'kneeCave',
      label: 'Knee tracking (cave-in)',
      display: cavingReps === 0 ? 'knees track over the feet on every rep' : `knees caved inward on ${cavingReps} of ${reps.length} reps`,
      band: cavingReps === 0 ? 'good' : 'caving',
      confidence: conf('medium'),
    });
  }
  metrics.push(
    {
      id: 'tempo',
      label: 'Descent control',
      display: fastReps === 0 ? 'controlled on every rep' : `${fastReps} of ${reps.length} reps dropped fast`,
      band: fastReps === 0 ? 'good' : 'rushed',
      confidence: conf('medium'),
    },
    {
      id: 'consistency',
      label: 'Depth consistency',
      display: `${Math.round(depthConsistency * 100)}% consistent across the set${fatigued ? ' — fading late' : ''}`,
      band: fatigued ? 'fading' : depthConsistency >= 0.85 ? 'good' : 'varied',
      confidence: conf('high'),
    },
  );

  const COPY = {
    depth: {
      good: ['Hitting depth', 'Every rep reached parallel or below — full range of motion, full benefit.'],
      mixed: ['Inconsistent depth', 'Some reps hit depth and some cut short. Pick a depth standard and own it on every rep — a box or a pause can help calibrate.'],
      shallow: ['Cutting depth', 'Most reps stopped above parallel. If mobility allows, work toward hip-crease-below-knee — or shorten the bar/load until depth is there.'],
    },
    backAngle: {
      good: ['Solid torso position', 'Your back angle stays in a healthy range at the bottom — the hips and legs are doing the lifting.'],
      folded: ['Folding forward', 'Your torso tips far forward at the bottom, which shifts load to the lower back. Cue "chest up through the floor" and consider heel elevation or a lighter load.'],
    },
    tempo: {
      good: ['Controlled descent', 'You own the lowering phase on every rep — that control is where strength is built.'],
      rushed: ['Dropping into the hole', 'Some reps free-fall down. A 2-second descent keeps tension on the muscle and is much kinder to the knees and hips.'],
    },
    hipsFirst: {
      good: ['Strong drive out of the hole', 'Your hips and chest rise together — the legs are pushing the floor away instead of the back taking over.'],
      fault: ['Hips shooting up first', 'On some reps your hips rise before your chest, turning the squat into a back lift. Cue "chest up first" and try pausing one second at the bottom.'],
    },
    kneeCave: {
      good: ['Knees tracking well', 'Your knees stay out over your feet through the whole rep — that\u2019s exactly the tracking you want.'],
      caving: ['Knees caving in', 'Your knees drift inward under load — a common pattern worth fixing early. Cue "spread the floor" and consider a band around the knees on warm-up sets.'],
    },
    consistency: {
      good: ['Repeatable reps', 'Your depth barely varies across the set — that consistency is what quality volume looks like.'],
      varied: ['Variable reps', 'Depth changes noticeably rep to rep. Slow down between reps and reset your stance and brace each time.'],
      fading: ['Fading late in the set', 'Your last reps are clearly shallower than your best — classic fatigue. Consider stopping a rep or two earlier, or resting longer between sets.'],
    },
  };

  const strengths = [], improvements = [];
  for (const m of metrics) {
    if (m.confidence === 'low' || m.confidence === 'none') continue;
    const copy = COPY[m.id]?.[m.band];
    if (!copy) continue;
    const item = { id: m.id, title: copy[0], detail: copy[1], measured: m.display, confidence: m.confidence };
    (m.band === 'good' ? strengths : improvements).push(item);
  }

  const notMeasured = [];
  for (const m of metrics) {
    if (m.confidence === 'low') {
      notMeasured.push({ label: m.label, reason: 'Measured, but with low confidence from this camera angle/quality — treat as a rough indication.' });
    }
  }
  if (sideish) {
    notMeasured.push({
      label: 'Knee cave (valgus)',
      reason: 'Only visible from the front. Film your next set facing the camera and we\u2019ll check knee tracking instead.',
    });
  } else {
    notMeasured.push({
      label: 'Depth, back angle, hip drive',
      reason: 'Only visible from the side. Film your next set side-on and we\u2019ll measure depth and torso position instead.',
    });
  }
  notMeasured.push({
    label: 'Bar path in 3D, load on the bar, force output',
    reason: 'These need 3D capture or sensors. A single phone camera can\u2019t measure them honestly, so this analysis doesn\u2019t guess at them.',
  });

  // Coach-style set summary, composed strictly from the measurements above.
  const summaryBits = [];
  summaryBits.push(`${reps.length} rep${reps.length > 1 ? 's' : ''} tracked${sideish ? '' : ' (front view)'}.`);
  if (sideish) {
    summaryBits.push(deepCount === reps.length
      ? 'Every rep hit parallel or below.'
      : `${deepCount} of ${reps.length} hit depth.`);
    if (hipsFirstReps > 0) summaryBits.push(`Hips shot up early on ${hipsFirstReps}.`);
  } else if (cavingReps > 0) {
    summaryBits.push(`Knees caved on ${cavingReps}.`);
  }
  if (fatigued) summaryBits.push('Depth faded late in the set — fatigue showed up.');
  if (fastReps > 0) summaryBits.push(`${fastReps} descent${fastReps > 1 ? 's were' : ' was'} rushed.`);
  if (setScore !== null) summaryBits.push(`Best rep: #${bestRepIdx + 1}.`);

  return {
    ok: true,
    sport: 'squat',
    bodyH,
    view,
    reps,
    repCount: reps.length,
    repScores,
    setScore,
    setGrade: setScore !== null ? gradeOf(setScore) : null,
    bestRepIdx,
    summary: summaryBits.join(' '),
    quality: { ...quality, visibility },
    metrics,
    feedback: { strengths: strengths.slice(0, 3), improvements: improvements.slice(0, 3) },
    notMeasured,
  };
}
