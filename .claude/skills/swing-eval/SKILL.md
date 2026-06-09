---
name: swing-eval
description: Run the swing-analysis verification suite — unit tests on the synthetic swing plus (optionally) the headless-browser end-to-end check on a real video — and summarize whether the analysis pipeline still behaves honestly. Use after any change to metrics.js or app.js, or when asked "did we break the analysis?". Pass a video path as an argument to include the e2e check.
---

# Swing analysis evaluation

Run the project's verification suite and report results in plain language.

## Steps

1. **Unit tests**: run `node --test` in the repo root. All tests must pass.
   These cover key-moment ordering, stride ground truth, head-drift bands,
   hip-before-hands sequencing, view classification, and the honesty
   contract (every feedback item carries a measurement + confidence).

2. **End-to-end (if a video path was provided as an argument, or if a
   sample video exists at `/tmp/golf_test.mp4`)**:
   - Ensure puppeteer is available: `npm i --no-save puppeteer`
   - Run `node scripts/e2e.mjs <video>`
   - This serves the app, uploads the video in headless Chrome, waits for
     analysis, and prints the structured result + saves screenshots to
     `/tmp/poc_result_*.png`.

3. **Honesty regression check** — inspect the e2e JSON output for these
   invariants and flag any violation prominently:
   - No metric with `confidence: "none"` or `band: "unknown"` appears in
     strengths/improvements.
   - The `notMeasured` list always includes the 3D limitations entry
     (attack angle / hip-shoulder separation / weight transfer).
   - Quality tips appear whenever `samplingGood` is false.

4. **Report**: summarize pass/fail, the metric values from the e2e run,
   and any behavior change vs. what's documented in README.md. If
   screenshots were produced, send them to the user with SendUserFile.
