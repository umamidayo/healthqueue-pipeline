import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCHEMA_VERSION, clampWindowDays, validateDataset } from '../src/dataset.mjs';
import { attributeIncidents, computeCore, computeMetrics } from '../src/metrics.mjs';
import { percentile } from '../src/stats.mjs';

const window = { start: '2026-10-01T00:00:00Z', end: '2026-10-11T00:00:00Z', days: 10 };
const prod = (id, deployedAt, extra = {}) => ({
  id,
  environment: 'production',
  deployedAt,
  status: 'success',
  sourceRevision: id,
  rework: false,
  changes: [],
  ...extra,
});

function dataset(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: 'o/r',
    source: 'synthetic',
    generatedAt: window.end,
    window,
    deployments: [],
    incidents: [],
    pipelineRuns: [],
    pullRequests: [],
    ...overrides,
  };
}

describe('stats', () => {
  it('interpolates percentiles', () => {
    assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
    assert.equal(percentile([5], 90), 5);
    assert.equal(percentile([], 50), null);
  });
});

describe('dataset contract', () => {
  it('caps the window at 90 days', () => {
    assert.equal(clampWindowDays('90'), 90);
    assert.throws(() => clampWindowDays(91), /capped at 90/);
    assert.throws(() => clampWindowDays(0), /positive integer/);
  });

  it('rejects malformed datasets with every problem listed', () => {
    assert.throws(
      () => validateDataset({ schemaVersion: 1, window, deployments: [{ id: 1, environment: 'dev', status: 'ok', deployedAt: 'x' }] }),
      (e) => /bad environment/.test(e.message) && /bad status/.test(e.message) && /incidents must be an array/.test(e.message),
    );
  });
});

describe('computeCore', () => {
  it('computes deployment frequency from successful production deploys only', () => {
    const ds = dataset({
      deployments: [
        prod('a', '2026-10-02T10:00:00Z'),
        prod('b', '2026-10-03T10:00:00Z'),
        prod('c', '2026-10-03T12:00:00Z', { status: 'failure' }),
        { ...prod('s', '2026-10-03T09:00:00Z'), environment: 'staging' },
        prod('old', '2026-09-20T10:00:00Z'),
      ],
    });
    const m = computeCore(ds, window);
    assert.equal(m.deploymentFrequency.deployments, 2);
    assert.equal(m.deploymentFrequency.attempted, 3);
    assert.equal(m.deploymentFrequency.activeDays, 2);
    assert.ok(Math.abs(m.deploymentFrequency.perWeek - 1.4) < 1e-9);
    assert.equal(m.deploymentFrequency.band, 'high');
  });

  it('measures lead time per human commit to its first deploy, ignoring bots', () => {
    const ds = dataset({
      deployments: [
        prod('a', '2026-10-02T12:00:00Z', {
          changes: [
            { sha: 'c1', authoredAt: '2026-10-02T10:00:00Z', bot: false }, // 2h
            { sha: 'c2', authoredAt: '2026-10-02T06:00:00Z', bot: false }, // 6h
            { sha: 'bump', authoredAt: '2026-10-02T11:00:00Z', bot: true },
          ],
        }),
        // c1 shows up again (e.g. re-deploy); must not be counted twice.
        prod('b', '2026-10-03T12:00:00Z', { changes: [{ sha: 'c1', authoredAt: '2026-10-02T10:00:00Z', bot: false }] }),
      ],
    });
    const m = computeCore(ds, window);
    assert.equal(m.leadTime.changes, 2);
    assert.equal(m.leadTime.p50Hours, 4);
    assert.equal(m.leadTime.band, 'elite');
  });

  it('counts failed syncs and incident-causing deploys in the change fail rate', () => {
    const ds = dataset({
      deployments: [
        prod('a', '2026-10-02T10:00:00Z'),
        prod('b', '2026-10-03T10:00:00Z'),
        prod('c', '2026-10-04T10:00:00Z', { status: 'failure' }),
        prod('d', '2026-10-04T11:00:00Z'),
      ],
      incidents: [{ id: 'i1', openedAt: '2026-10-03T12:00:00Z', resolvedAt: '2026-10-03T14:00:00Z', deploymentId: null }],
    });
    const m = computeCore(ds, window);
    assert.equal(m.changeFailRate.failed, 2); // b (inferred incident) + c (failed sync)
    assert.equal(m.changeFailRate.total, 4);
    assert.equal(m.changeFailRate.rate, 0.5);
    // recovery: incident 2h, failed deploy -> next success 1h
    assert.equal(m.recoveryTime.samples, 2);
    assert.equal(m.recoveryTime.p50Hours, 1.5);
  });

  it('computes rework rate', () => {
    const ds = dataset({ deployments: [prod('a', '2026-10-02T10:00:00Z'), prod('b', '2026-10-02T12:00:00Z', { rework: true })] });
    assert.equal(computeCore(ds, window).reworkRate.rate, 0.5);
  });

  it('returns nulls rather than zeros when there is no data', () => {
    const m = computeCore(dataset(), window);
    assert.equal(m.leadTime.p50Hours, null);
    assert.equal(m.changeFailRate.rate, null);
    assert.equal(m.leadTime.band, null);
  });
});

describe('attributeIncidents', () => {
  const deployments = [prod('a', '2026-10-02T10:00:00Z'), prod('b', '2026-10-05T10:00:00Z')];

  it('prefers explicit attribution', () => {
    const [i] = attributeIncidents(deployments, [{ id: 'x', openedAt: '2026-10-05T11:00:00Z', deploymentId: 'a' }]);
    assert.equal(i.attributedTo, 'a');
    assert.equal(i.attribution, 'explicit');
  });

  it('infers the latest deploy inside the attribution window', () => {
    const [i] = attributeIncidents(deployments, [{ id: 'x', openedAt: '2026-10-05T20:00:00Z' }]);
    assert.equal(i.attributedTo, 'b');
  });

  it('leaves incidents far from any deploy unattributed', () => {
    const [i] = attributeIncidents(deployments, [{ id: 'x', openedAt: '2026-10-04T10:00:00Z' }]);
    assert.equal(i.attributedTo, null);
  });
});

describe('computeMetrics', () => {
  it('omits the 30-day comparison for short windows', () => {
    assert.equal(computeMetrics(dataset()).comparison, null);
  });

  it('produces one weekly bucket per calendar week touched', () => {
    // 2026-10-01 is a Thursday: weeks of 09-28 and 10-05 (window ends 10-11 00:00 Sunday)
    assert.deepEqual(
      computeMetrics(dataset()).weekly.map((w) => w.weekStart),
      ['2026-09-28', '2026-10-05'],
    );
  });
});
