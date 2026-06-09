# ⚾ Swing Analysis — Proof of Concept

Upload (or record) a video of a baseball swing and get an honest, measured
assessment — entirely in your phone's browser. No app install, no backend:
**the video never leaves your device.**

**Try it:** open the GitHub Pages URL for this repo on your phone →
record/choose a video of one swing → wait ~30–60s.

## What it does

1. **Pose estimation in-browser** — MediaPipe Pose (vendored, runs via
   WebAssembly/WebGL) finds 33 body keypoints in each video frame.
2. **Two-pass scan** — a coarse pass finds the swing (peak wrist motion),
   then a fine pass measures ~30fps frames around it.
3. **Key moments** — stance, stride, foot plant, contact, finish — shown as
   tappable frames with a skeleton overlay.
4. **Honest metrics with confidence levels** — head movement, stride length,
   front-leg angle at contact, spine tilt, hips-before-hands sequencing.
   Every number carries a confidence grade based on video quality
   (frame rate, camera angle, visibility, person size).
5. **Feedback** — strengths and improvement areas, each tied to a displayed
   measurement — plus an explicit **"what we could NOT measure"** section.

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

## Repo layout

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | Mobile-first UI + video/pose pipeline |
| `metrics.js` | Pure metric/feedback functions (no DOM — unit-testable) |
| `test/metrics.test.mjs` | Unit tests with a synthetic swing (`npm test`) |
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
