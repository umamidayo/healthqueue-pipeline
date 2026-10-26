import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMetrics } from '../src/metrics.mjs';
import { renderMarkdown } from '../src/report.mjs';
import { generateSample } from '../src/sample.mjs';
import { DEFAULT_COSTS, TARGETS, analyzeToil, recommend } from '../src/toil.mjs';

const quietSignals = {
  months: 3,
  runs: 100,
  rerunRate: 0.01,
  rerunsPerMonth: 0.3,
  prCiP50Minutes: 4,
  prCiP90Minutes: 6,
  prRunsPerMonth: 40,
  mainToStagingP90Minutes: 12,
  reviewWaitP50Hours: 1,
  reviewWaitP90Hours: 3,
  humanPrsPerMonth: 30,
  botPrsPerMonth: 2,
  promotionWaitP50Hours: 2,
  promotionsPerMonth: 20,
  batchSizeMedian: 2,
  changeFailRate: 0.02,
  recoveryP50Hours: 0.3,
  reworkRate: 0.01,
  incidentPersonHoursPerMonth: 1,
};

describe('recommend', () => {
  it('stays silent when every signal is healthy', () => {
    assert.deepEqual(recommend(quietSignals), []);
  });

  it('flags flaky CI with a toil estimate from the cost model', () => {
    const [r] = recommend({ ...quietSignals, rerunRate: 0.12, rerunsPerMonth: 20 });
    assert.equal(r.id, 'flaky-ci');
    assert.equal(r.priority, 'P1'); // >= 2x target
    assert.equal(r.toilHoursPerMonth, (20 * DEFAULT_COSTS.rerunMinutes) / 60);
  });

  it('flags slow promotion as both toil and flow', () => {
    const [r] = recommend({ ...quietSignals, promotionWaitP50Hours: 30 });
    assert.equal(r.id, 'manual-promotion');
    assert.equal(r.priority, 'P2');
    assert.ok(r.toilHoursPerMonth > 0);
    assert.equal(r.leadTimeHoursSaved, (30 - TARGETS.promotionWaitP50Hours) * 20);
  });

  it('orders by priority before score', () => {
    const recs = recommend({ ...quietSignals, changeFailRate: 0.4, botPrsPerMonth: 30 });
    assert.deepEqual(
      recs.map((r) => [r.id, r.priority]),
      [
        ['change-failures', 'P1'],
        ['dependency-pr-toil', 'P2'],
      ],
    );
  });

  it('marks signals within 80% of target as P3 (watch)', () => {
    const [r] = recommend({ ...quietSignals, reviewWaitP50Hours: 3.5 });
    assert.equal(r.id, 'review-latency');
    assert.equal(r.priority, 'P3');
  });

  it('ignores signals that have no data', () => {
    const recs = recommend({ ...quietSignals, prCiP90Minutes: null, prCiP50Minutes: null, recoveryP50Hours: null });
    assert.deepEqual(recs, []);
  });
});

describe('sample + report (end to end)', () => {
  const end = new Date('2026-10-25T00:00:00Z');

  it('is deterministic for a given seed', () => {
    assert.deepEqual(generateSample({ end, seed: 7 }), generateSample({ end, seed: 7 }));
    assert.notDeepEqual(generateSample({ end, seed: 7 }).deployments, generateSample({ end, seed: 8 }).deployments);
  });

  it('respects the 90-day cap', () => {
    assert.throws(() => generateSample({ end, days: 120 }), /capped at 90/);
  });

  it('renders every report section with recommendations', () => {
    const dataset = generateSample({ end });
    const metrics = computeMetrics(dataset);
    const toil = analyzeToil(dataset, metrics);
    const md = renderMarkdown({ dataset, metrics, toil });
    for (const heading of ['## Summary', '## Weekly trend', '## Toil and flow signals', '## Toil reduction recommendations', '## Method and caveats']) {
      assert.ok(md.includes(heading), heading);
    }
    assert.match(md, /Synthetic data/);
    assert.ok(toil.recommendations.length > 0);
    assert.equal(metrics.weekly.length, 13);
    assert.ok(metrics.comparison);
  });
});
