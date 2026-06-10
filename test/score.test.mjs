// Tests for the composite swing score and side-by-side timeline alignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSwing, alignTimelines } from '../metrics.js';

const metric = (id, band, confidence = 'high') => ({ id, label: id, band, confidence });

function fakeAnalysis(bands) {
  return {
    ok: true,
    metrics: Object.entries(bands).map(([id, band]) =>
      metric(id, band, band === 'unknown' ? 'none' : 'high')),
    keyMoments: { stance: 2, strideStart: 10, footPlant: 20, contact: 30, finish: 40 },
  };
}

test('perfect swing scores 100 with grade A', () => {
  const s = scoreSwing(fakeAnalysis({
    headDrift: 'good', sequence: 'good', stride: 'good', frontKnee: 'good', posture: 'good',
  }));
  assert.equal(s.score, 100);
  assert.equal(s.grade, 'A');
  assert.equal(s.scoredCount, 5);
});

test('unmeasured metrics shrink the scorecard instead of penalizing', () => {
  // Same quality of swing, but stride + sequence unmeasurable -> score
  // computed over remaining weights only, not dragged to 0.
  const s = scoreSwing(fakeAnalysis({
    headDrift: 'good', sequence: 'unknown', stride: 'unknown', frontKnee: 'good', posture: 'good',
  }));
  assert.equal(s.score, 100);
  assert.equal(s.scoredCount, 3);
  assert.equal(s.totalCount, 5);
});

test('weak bands reduce the score', () => {
  const s = scoreSwing(fakeAnalysis({
    headDrift: 'needs_work', sequence: 'check', stride: 'short', frontKnee: 'soft', posture: 'check',
  }));
  assert.ok(s.score < 50, `expected <50, got ${s.score}`);
});

test('nothing measurable returns null (no fake score)', () => {
  const s = scoreSwing(fakeAnalysis({
    headDrift: 'unknown', sequence: 'unknown', stride: 'unknown', frontKnee: 'unknown', posture: 'unknown',
  }));
  assert.equal(s, null);
  assert.equal(scoreSwing({ ok: false }), null);
});

test('alignTimelines anchors both swings at contact', () => {
  const a = fakeAnalysis({ headDrift: 'good' });
  const b = { ...fakeAnalysis({ headDrift: 'good' }), keyMoments: { stance: 0, strideStart: 5, footPlant: 12, contact: 50, finish: 80 } };
  const { a: la, b: lb, contactStep } = alignTimelines(a, b, 60);
  assert.equal(la.length, 60);
  assert.equal(lb.length, 60);
  assert.equal(la[contactStep], 30, 'lane A hits its contact frame at the anchor step');
  assert.equal(lb[contactStep], 50, 'lane B hits its contact frame at the anchor step');
  assert.equal(la[0], 10); assert.equal(la[59], 40);
  assert.equal(lb[0], 5); assert.equal(lb[59], 80);
  for (const lane of [la, lb]) {
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i] >= lane[i - 1], 'monotonic');
  }
});
