// Shared synthetic-swing fixtures used by the metrics and ghost tests.
import { LM } from '../metrics.js';

export function blankPose() {
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

export const clonePose = (lm) => lm.map((p) => ({ ...p }));

// Build a 30fps synthetic swing. Body height in image ~0.5.
// Timeline (frames): 0-14 stance, 15-24 stride (front/L ankle moves +0.10x),
// 25-28 hips fire, 29-33 hands fire (contact at 33), 34-45 follow-through.
export function syntheticSwing({ headDrift = 0.02 } = {}) {
  const frames = [];
  const fps = 30;
  const base = blankPose();
  for (let i = 0; i <= 45; i++) {
    const lm = clonePose(base);
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

// The same swing mirrored left<->right (a lefty, striding toward -x).
export function mirroredSwing(opts) {
  return syntheticSwing(opts).map((f) => ({
    t: f.t,
    landmarks: f.landmarks.map((p) => ({ ...p, x: 1 - p.x })),
  }));
}
