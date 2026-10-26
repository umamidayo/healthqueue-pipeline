// Pure DORA metric computation over a normalized dataset (see dataset.mjs).
//
// Definitions follow the DORA research program's current five metrics:
//   Throughput: deployment frequency, change lead time, failed deployment
//               recovery time
//   Instability: change fail rate, deployment rework rate
// Performance bands are the widely used 2023 cluster thresholds. DORA's later
// reports cluster teams differently each year, so treat bands as a rough
// orientation, not a grade (docs/dora.md).
import { DAY_MS, hoursBetween, median, percentile, ratio, weekStart } from './stats.mjs';

export const BANDS = {
  deploymentFrequency: [
    // deploys per day (prod)
    { band: 'elite', min: 1 },
    { band: 'high', min: 1 / 7 },
    { band: 'medium', min: 1 / 30 },
    { band: 'low', min: 0 },
  ],
  leadTimeHours: [
    { band: 'elite', max: 24 },
    { band: 'high', max: 24 * 7 },
    { band: 'medium', max: 24 * 30 },
    { band: 'low', max: Infinity },
  ],
  changeFailRate: [
    { band: 'elite', max: 0.05 },
    { band: 'high', max: 0.1 },
    { band: 'medium', max: 0.15 },
    { band: 'low', max: Infinity },
  ],
  recoveryHours: [
    { band: 'elite', max: 1 },
    { band: 'high', max: 24 },
    { band: 'medium', max: 24 * 7 },
    { band: 'low', max: Infinity },
  ],
};

function bandFor(table, value) {
  if (value === null || value === undefined) return null;
  const hit = table.find((t) => ('min' in t ? value >= t.min : value <= t.max));
  return hit?.band ?? null;
}

const inWindow = (t, window) => {
  const ts = new Date(t).getTime();
  return ts >= new Date(window.start).getTime() && ts <= new Date(window.end).getTime();
};

/**
 * Attributes incidents to the production deployment that caused them: either
 * explicitly (incident.deploymentId) or, failing that, the latest successful
 * production deployment within `attributionHours` before the incident opened.
 */
export function attributeIncidents(deployments, incidents, attributionHours = 24) {
  const prod = deployments
    .filter((d) => d.environment === 'production' && d.status === 'success')
    .sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt));
  const byId = new Map(prod.map((d) => [String(d.id), d]));
  return incidents.map((inc) => {
    if (inc.deploymentId && byId.has(String(inc.deploymentId))) {
      return { ...inc, attributedTo: String(inc.deploymentId), attribution: 'explicit' };
    }
    const opened = new Date(inc.openedAt).getTime();
    let candidate = null;
    for (const d of prod) {
      const t = new Date(d.deployedAt).getTime();
      if (t > opened) break;
      if (opened - t <= attributionHours * 3_600_000) candidate = d;
    }
    return candidate
      ? { ...inc, attributedTo: String(candidate.id), attribution: 'inferred' }
      : { ...inc, attributedTo: null, attribution: 'none' };
  });
}

/** Core metrics for one slice of time. */
export function computeCore(dataset, window, options = {}) {
  const days = Math.max((new Date(window.end) - new Date(window.start)) / DAY_MS, 1 / 24);
  const prodAll = dataset.deployments.filter((d) => d.environment === 'production');
  const prod = prodAll.filter((d) => inWindow(d.deployedAt, window));
  const successes = prod.filter((d) => d.status === 'success');
  const failures = prod.filter((d) => d.status === 'failure');

  // Lead time: every human-authored commit, measured to the first successful
  // production deployment that contained it.
  const seen = new Set();
  const leadTimes = [];
  const batchSizes = [];
  for (const d of [...successes].sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt))) {
    let batch = 0;
    for (const c of d.changes ?? []) {
      if (c.bot || seen.has(c.sha)) continue;
      seen.add(c.sha);
      leadTimes.push(hoursBetween(c.authoredAt, d.deployedAt));
      batch += 1;
    }
    batchSizes.push(batch);
  }

  const incidents = attributeIncidents(dataset.deployments, dataset.incidents ?? [], options.attributionHours).filter(
    (i) => inWindow(i.openedAt, window),
  );
  const causedFailure = new Set(incidents.filter((i) => i.attributedTo).map((i) => i.attributedTo));
  const failedDeployments = successes.filter((d) => causedFailure.has(String(d.id))).length + failures.length;

  // Recovery: incident duration for deployment-caused incidents, plus time
  // from a failed deployment to the next successful one.
  const recovery = incidents
    .filter((i) => i.attributedTo && i.resolvedAt)
    .map((i) => hoursBetween(i.openedAt, i.resolvedAt));
  const ordered = [...prodAll].sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt));
  for (const f of failures) {
    const next = ordered.find((d) => d.status === 'success' && new Date(d.deployedAt) > new Date(f.deployedAt));
    if (next) recovery.push(hoursBetween(f.deployedAt, next.deployedAt));
  }

  const reworkDeployments = successes.filter((d) => d.rework).length;
  const perDay = successes.length / days;
  const leadP50 = median(leadTimes);
  const cfr = ratio(failedDeployments, prod.length);
  const recP50 = median(recovery);

  return {
    deploymentFrequency: {
      deployments: successes.length,
      attempted: prod.length,
      perDay,
      perWeek: perDay * 7,
      activeDays: new Set(successes.map((d) => d.deployedAt.slice(0, 10))).size,
      band: bandFor(BANDS.deploymentFrequency, perDay),
    },
    leadTime: {
      changes: leadTimes.length,
      p50Hours: leadP50,
      p90Hours: percentile(leadTimes, 90),
      medianBatchSize: median(batchSizes),
      band: bandFor(BANDS.leadTimeHours, leadP50),
    },
    changeFailRate: {
      failed: failedDeployments,
      total: prod.length,
      rate: cfr,
      band: bandFor(BANDS.changeFailRate, cfr),
    },
    recoveryTime: {
      samples: recovery.length,
      p50Hours: recP50,
      p90Hours: percentile(recovery, 90),
      band: bandFor(BANDS.recoveryHours, recP50),
    },
    reworkRate: {
      rework: reworkDeployments,
      total: successes.length,
      rate: ratio(reworkDeployments, successes.length),
    },
    incidents: {
      total: incidents.length,
      attributed: incidents.filter((i) => i.attributedTo).length,
      open: incidents.filter((i) => !i.resolvedAt).length,
    },
  };
}

/** Week-by-week series across the window (weeks start Monday UTC). */
export function weeklyTrend(dataset, window, options) {
  const out = [];
  const end = new Date(window.end);
  for (let w = weekStart(window.start); w <= end; w = new Date(w.getTime() + 7 * DAY_MS)) {
    const start = new Date(Math.max(w.getTime(), new Date(window.start).getTime()));
    const stop = new Date(Math.min(w.getTime() + 7 * DAY_MS - 1, end.getTime()));
    const m = computeCore(dataset, { start: start.toISOString(), end: stop.toISOString() }, options);
    out.push({
      weekStart: w.toISOString().slice(0, 10),
      deployments: m.deploymentFrequency.deployments,
      leadTimeP50Hours: m.leadTime.p50Hours,
      failed: m.changeFailRate.failed,
      changeFailRate: m.changeFailRate.rate,
      recoveryP50Hours: m.recoveryTime.p50Hours,
    });
  }
  return out;
}

/** Full metric set: whole window, weekly trend, and first-vs-last 30 days. */
export function computeMetrics(dataset, options = {}) {
  const { window } = dataset;
  const result = {
    window,
    overall: computeCore(dataset, window, options),
    weekly: weeklyTrend(dataset, window, options),
    comparison: null,
  };
  if (window.days >= 60) {
    const start = new Date(window.start).getTime();
    const end = new Date(window.end).getTime();
    result.comparison = {
      first30: computeCore(dataset, { start: window.start, end: new Date(start + 30 * DAY_MS).toISOString() }, options),
      last30: computeCore(dataset, { start: new Date(end - 30 * DAY_MS).toISOString(), end: window.end }, options),
    };
  }
  return result;
}
