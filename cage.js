// Cage Mode core: live swing detection + one-cue feedback.
// Pure logic (no DOM, no camera) — unit-tested in Node.
//
// SwingDetector consumes pose frames one at a time from a live stream and
// emits a completed-swing window. pickCue turns an analysis into exactly
// ONE spoken cue — real coaches don't stack corrections, and neither do we.
import { LM } from './metrics.js';

// All field-tunable knobs in one place. Speeds are in body-heights/second.
export const CAGE_TUNING = {
  bufferSeconds: 5,        // rolling skeleton history
  enterSpeed: 2.2,         // wrist speed that starts a swing
  exitSpeed: 0.9,          // wrist speed that ends the follow-through
  minSwingPeak: 3.0,       // peak must reach this or it wasn't a swing
  quietBeforeS: 0.4,       // stillness required to arm
  exitHoldS: 0.30,         // how long below exitSpeed = swing finished
  maxSwingS: 1.6,          // safety: force-complete a "swing" after this
  windowBeforePeakS: 1.8,  // captured context before peak (stance + stride)
  windowAfterPeakS: 0.9,   // captured follow-through
  cooldownS: 2.5,          // re-arm delay after emitting (cue playback time)
  minPersonHeight: 0.2,    // body must fill >=20% of frame to track
};

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class SwingDetector {
  constructor(tuning = CAGE_TUNING) {
    this.tuning = tuning;
    this.buffer = [];          // [{ t, landmarks }]
    this.state = 'waiting';    // waiting -> armed -> swinging -> cooldown
    this.lastSpeed = 0;
    this.peakSpeed = 0;
    this.peakT = 0;
    this.swingStartT = 0;
    this.belowExitSince = null;
    this.cooldownUntil = 0;
    this.quietSince = null;
  }

  bodyHeight() {
    const recent = this.buffer.slice(-15);
    if (!recent.length) return 0;
    const hs = recent.map((f) => {
      const ankleY = (f.landmarks[LM.L_ANKLE].y + f.landmarks[LM.R_ANKLE].y) / 2;
      return Math.abs(ankleY - f.landmarks[LM.NOSE].y);
    }).sort((a, b) => a - b);
    return hs[Math.floor(hs.length / 2)];
  }

  // Feed one frame; returns null or { type: 'swing', frames, peakSpeed }.
  push(frame) {
    const T = this.tuning;
    this.buffer.push(frame);
    const cutoff = frame.t - T.bufferSeconds;
    while (this.buffer.length && this.buffer[0].t < cutoff) this.buffer.shift();

    const bodyH = this.bodyHeight();
    if (!bodyH || bodyH < T.minPersonHeight) { this.state = 'waiting'; this.quietSince = null; return null; }

    // wrist speed (mean of both wrists), smoothed over the last 2 intervals
    const n = this.buffer.length;
    if (n < 3) return null;
    const speedAt = (i) => {
      const a = this.buffer[i - 1], b = this.buffer[i];
      const dt = Math.max(1e-3, b.t - a.t);
      const w = (dist(b.landmarks[LM.L_WRIST], a.landmarks[LM.L_WRIST]) +
                 dist(b.landmarks[LM.R_WRIST], a.landmarks[LM.R_WRIST])) / 2;
      return (w / dt) / bodyH;
    };
    const speed = (speedAt(n - 1) + speedAt(n - 2)) / 2;
    this.lastSpeed = speed;

    switch (this.state) {
      case 'waiting':
        if (speed < T.exitSpeed) {
          this.quietSince ??= frame.t;
          if (frame.t - this.quietSince >= T.quietBeforeS) this.state = 'armed';
        } else this.quietSince = null;
        return null;

      case 'armed':
        if (speed >= T.enterSpeed) {
          this.state = 'swinging';
          this.swingStartT = frame.t;
          this.peakSpeed = speed;
          this.peakT = frame.t;
          this.belowExitSince = null;
        }
        return null;

      case 'swinging': {
        if (speed > this.peakSpeed) { this.peakSpeed = speed; this.peakT = frame.t; }
        const done =
          (speed < T.exitSpeed &&
            (this.belowExitSince ??= frame.t) &&
            frame.t - this.belowExitSince >= T.exitHoldS) ||
          frame.t - this.swingStartT >= T.maxSwingS;
        if (speed >= T.exitSpeed) this.belowExitSince = null;
        if (!done) return null;

        this.state = 'cooldown';
        this.cooldownUntil = frame.t + T.cooldownS;
        this.quietSince = null;
        if (this.peakSpeed < T.minSwingPeak) return null;   // wiggle, not a swing
        const start = this.peakT - T.windowBeforePeakS;
        const end = this.peakT + T.windowAfterPeakS;
        const frames = this.buffer.filter((f) => f.t >= start && f.t <= end);
        return { type: 'swing', frames, peakSpeed: this.peakSpeed };
      }

      case 'cooldown':
        if (frame.t >= this.cooldownUntil) this.state = 'waiting';
        return null;
    }
    return null;
  }
}

/* ---------- cue engine ---------- */

// Priority-ordered: first matching fault wins. Cues are short imperatives
// meant to be SPOKEN. Only metrics measured with confidence >= medium may
// speak — the honesty contract applies to the voice too.
const FAULT_CUES = [
  ['headDrift', 'needs_work', 'Keep your head still. Eyes on the contact point.'],
  ['sequence', 'check', 'Let your hips start the swing, then the hands.'],
  ['frontKnee', 'soft', 'Firm up that front leg at contact.'],
  ['stride', 'long', 'Shorten the stride a touch. Stay balanced.'],
  ['stride', 'short', 'Stride toward the pitcher. Get your weight moving.'],
  ['posture', 'check', 'Stay tall. Keep your spine angle steady.'],
  ['headDrift', 'fair', 'Quiet the head just a little more.'],
];

const PRAISE = [
  'Good swing!',
  "That's it. Same swing again.",
  'Nice. Head quiet, hips leading.',
  'Strong. Run it back.',
];

const SPEAKABLE = new Set(['high', 'medium']);

export function pickCue(analysis, score, praiseIdx = 0) {
  if (!analysis?.ok) {
    return { tone: 'miss', metricId: null, text: "Couldn't read that one. Make sure your whole body stays in frame." };
  }
  for (const [id, band, text] of FAULT_CUES) {
    const m = analysis.metrics.find((x) => x.id === id);
    if (m && m.band === band && SPEAKABLE.has(m.confidence)) {
      return { tone: 'fix', metricId: id, text };
    }
  }
  return { tone: 'praise', metricId: null, text: PRAISE[praiseIdx % PRAISE.length] };
}

// Session aggregation for the summary screen.
export function summarizeSession(swings) {
  const scored = swings.filter((s) => s.score !== null && s.score !== undefined);
  const cueCounts = {};
  for (const s of swings) {
    if (s.cue?.tone === 'fix') cueCounts[s.cue.text] = (cueCounts[s.cue.text] || 0) + 1;
  }
  const topCue = Object.entries(cueCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const best = scored.length ? Math.max(...scored.map((s) => s.score)) : null;
  return {
    reps: swings.length,
    bestScore: best,
    bestRep: best !== null ? swings.findIndex((s) => s.score === best) + 1 : null,
    avgScore: scored.length ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null,
    topCue: topCue ? { text: topCue[0], count: topCue[1] } : null,
    praises: swings.filter((s) => s.cue?.tone === 'praise').length,
  };
}
