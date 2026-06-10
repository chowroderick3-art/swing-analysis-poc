# ⚾ Swing Analysis — Proof of Concept

Upload (or record) a video of a baseball swing and get an honest, measured
assessment — entirely in your phone's browser. No app install, no backend:
**the video never leaves your device.**

**Try it:** open the GitHub Pages URL for this repo on your phone →
pick a mode → record/choose a video of one swing → wait ~30–60s.

## Five modes, one honest engine

| Mode | What it does |
|---|---|
| 🎯 **Coach Report** | Full assessment: key moments, skeleton overlay, measurements with confidence grades, strengths & fixes, and what we could NOT measure |
| 🕹️ **Swing Score** | Game mode: composite 0–100 score + letter grade, scored only on what was actually measured; beat your personal best |
| 🎓 **Swing School** | Tutorial: walks phase-by-phase through *your own* swing (stance → stride → foot plant → contact → finish), teaching what to look for |
| ⚖️ **Side-by-Side** | Compare two swings synced at contact with one slider; per-metric deltas |
| 📈 **Progress** | Every analysis saves to the device (localStorage only); score trend + history |

## How the engine works

1. **Pose estimation in-browser** — MediaPipe Pose (vendored, runs via
   WebAssembly/WebGL) finds 33 body keypoints in each video frame.
2. **Two-pass scan** — a coarse pass finds the swing (peak wrist motion),
   then a fine pass measures ~30fps frames around it.
3. **Key moments + metrics** — stance, stride, foot plant, contact, finish;
   head movement, stride length, front-leg angle, spine tilt,
   hips-before-hands sequencing — every number carries a confidence grade
   based on video quality (frame rate, camera angle, visibility).

## Design principle: truthful by construction

- The analysis **measures first, talks second**. Feedback is generated only
  from computed metrics — there is no AI model "eyeballing" the video and
  guessing at mechanics.
- Anything that genuinely requires 3D capture (bat attack angle,
  hip–shoulder separation velocity, weight transfer) is **declared
  unmeasurable** rather than estimated.
- Any video is accepted; quality issues lower confidence and produce
  recording tips (slow-mo, side view, tripod) instead of rejections.
- All thresholds in `metrics.js` are POC heuristics, not validated coaching
  standards.
- The game score is computed **only over measured parts** and says so
  ("scored on N of 5") — unmeasurable metrics shrink the scorecard instead
  of silently penalizing or inflating.

## Repo layout

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | Mobile-first UI + the five mode views |
| `engine.js` | Shared pose-model + video-scanning engine |
| `metrics.js` | Pure metric/score/feedback functions (no DOM — unit-testable) |
| `test/` | Unit tests: synthetic swing, scoring, timeline alignment (`npm test`) |
| `scripts/e2e.mjs` | Headless-Chrome end-to-end check (`node scripts/e2e.mjs <video>`) |
| `vendor/`, `models/` | Vendored MediaPipe Tasks Vision + pose model (no CDN dependency) |
| `.github/workflows/pages.yml` | Tests + deploy to GitHub Pages on push |

## Develop

```bash
npm test                          # unit tests
python3 -m http.server 8000       # serve locally
npm i --no-save puppeteer && node scripts/e2e.mjs path/to/swing.mp4   # e2e
```

## Status / roadmap

POC v1 — body-only (no bat tracking). Next increments, in order: LLM
coaching narrative grounded in these metrics → bat detection → stronger
pose backbone (RTMPose-class, server-side) or licensed processing
(e.g. Reboot Motion API) → guided-capture mode → app integration.
