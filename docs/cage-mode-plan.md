# Cage Mode — Live Swing Coaching: Plan & Replication Playbook

> Written before building (2026-06-10). This doc is both the build plan and
> the reusable pattern for turning ANY sport pack into a live-coaching mode.

## Goal

A hitter sets their phone on a tripod in a batting cage, opens FormLab,
taps Start, and just swings — over and over. After every swing, within
~1 second, the app **speaks one cue out loud**: "Good swing!" or "Keep
your head still." No tapping, no uploading, no reading. Field-testable
tonight.

## Why this is buildable in one shot

Everything hard already exists and is verified:
- **Pose engine runs live**: MediaPipe was designed for camera streams;
  our `detectForVideo` path works identically on a `getUserMedia` stream.
- **Swing detection** = the wrist-speed-peak detector already powering
  uploaded-video analysis, run on a rolling buffer instead of a file.
- **Metrics + scoring + honesty rules** (`analyzeSwing`, `scoreSwing`)
  consume `{t, landmarks}` frames and don't care where frames came from.
- **No video is ever stored** — only a few seconds of skeleton data.
  Faster, private, and no iOS codec/seek minefield (already burned us twice;
  the live path avoids it entirely).

## Architecture

```
camera stream → live pose (per frame) → rolling skeleton buffer (~5s)
   → SwingDetector state machine (armed → swinging → emit window → cooldown)
   → analyzeSwing(window) → scoreSwing → pickCue (ONE cue, priority-ranked)
   → speak cue (TTS) + flash score + skeleton replay → re-arm
   → session summary (reps, best/avg score, most-common cue) → history
```

### New modules
- `cage.js` — pure logic, unit-testable in Node:
  - `SwingDetector`: feed frames one at a time; emits a swing window when
    a swing completes. Tunable thresholds in one exported object.
  - `pickCue(analysis, score)`: ONE cue per swing (real coaches don't
    stack corrections). Priority: head drift > sequence > front knee >
    stride > posture. All clear → rotating praise. Only cues from metrics
    with confidence ≥ medium — the honesty contract applies to speech too.
- `app.js` additions — Cage UI: setup screen (tripod instructions, Start
  button), live screen (camera + live skeleton + rep counter + giant last
  cue), summary screen (reps, best/avg, cue frequency, run-it-back).
- `engine.js` addition — `detectLive(video)`: reuses the loaded model on
  a stream frame.

### Phone-specific decisions (learned the hard way in v2.x)
| Decision | Why |
|---|---|
| Start button does camera + TTS unlock + wake-lock in ONE tap | iOS requires user gestures for getUserMedia and speechSynthesis; wake lock stops the screen sleeping mid-session |
| Rear camera default, flip button available | Better sensor; tripod setup means the hitter isn't looking at the screen anyway — that's what the voice is for |
| Spoken feedback, not on-screen text | The user is 8–12 ft away holding a bat |
| Cooldown ~2.5s after each cue | Prevents double-fires on follow-through wiggle; matches natural reset rhythm |
| `?debug=1` URL flag shows live wrist-speed + detector state | Field tuning without a rebuild: if swings don't trigger tonight, the numbers on screen say why |
| Thresholds in one exported `CAGE_TUNING` object | Tonight's field data turns into a one-line tune |

## Test strategy (no camera in this sandbox)

1. **Unit (Node)**: synthetic swing frames through `SwingDetector` — fires
   exactly once per swing, not on idle wiggle, re-arms after cooldown.
   `pickCue` truth table: each fault band → expected cue; all-good → praise;
   low-confidence metrics never spoken.
2. **Headless e2e with a simulated live camera**: monkey-patch
   `getUserMedia` to return `videoElement.captureStream()` playing the real
   golf-swing clip on loop. Cage Mode's full real pipeline (live pose →
   detection → cue → counter) runs against it; assert reps ≥ 1, a cue
   rendered, no page errors. TTS wrapped in try/catch (headless has no voices).
3. **Field test (the user, tonight)**: protocol in README + final message.
   Debug flag is the instrument; thresholds are the knobs.

## Risks & mitigations
- **Detection threshold wrong for real swings** → debug overlay shows live
  peak speeds; CAGE_TUNING one-line fix; thresholds deliberately favor
  false-positive (extra rep) over false-negative (ignored swing).
- **Phone can't keep 30fps pose** → detector uses time-based windows, not
  frame counts; works down to ~10fps with degraded (confidence-flagged) cues.
- **iOS kills TTS/camera on screen sleep** → wake lock + keep-alive utterance.
- **Golf clip may not trigger in e2e** (different speed profile) → assert
  on detector internals too; unit tests carry detection correctness.

## The replication pattern (the actual learning)

Any sport pack becomes a live coach with the same recipe:
1. Rolling skeleton buffer (shared).
2. A **trigger** that finds one completed movement in the stream — swing =
   wrist-speed peak; squat rep = hip-drop cycle (already built in
   `segmentReps`!); serve = overhead reach; shot = release jump.
3. The pack's existing analyzer on the captured window.
4. `pickCue` with that pack's priority table.
5. Speak one cue. Re-arm. Summarize session.

Squat live coach ("rack mode") is therefore ~1 day after this lands: the
trigger already exists. This is the platform thesis proving itself.

## Definition of done (tonight)
- [ ] Cage Mode card in baseball menu; setup → live → summary flow
- [ ] Swing → spoken cue + score within ~1.5s, hands-free, repeatable
- [ ] Session summary with reps, best/avg score, top cue; saved to history
- [ ] All unit + e2e green; deployed via the usual zip handoff
- [ ] Field-test protocol + tuning instructions delivered with the build
