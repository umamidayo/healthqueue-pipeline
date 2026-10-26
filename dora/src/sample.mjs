// Deterministic synthetic dataset for demos, docs and tests. The shapes mimic
// what the GitHub collector produces for this pipeline (PR -> main CI ->
// staging -> promotion PR -> production), with a gentle improvement trend so
// the first-vs-last comparison has something to show. Not real data.
import { SCHEMA_VERSION, clampWindowDays } from './dataset.mjs';
import { DAY_MS, HOUR_MS } from './stats.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSample({ days = 90, seed = 42, end = new Date(), repo = 'umamidayo/healthqueue-pipeline' } = {}) {
  days = clampWindowDays(days);
  const rnd = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const lognormal = (medianHours, sigma = 0.8) => medianHours * Math.exp(sigma * normal());
  const poisson = (lambda) => {
    let k = 0;
    let p = 1;
    const l = Math.exp(-lambda);
    do {
      k += 1;
      p *= rnd();
    } while (p > l);
    return k - 1;
  };
  const sha = () => Array.from({ length: 40 }, () => Math.floor(rnd() * 16).toString(16)).join('');
  const iso = (ms) => new Date(Math.round(ms)).toISOString();

  const endMs = new Date(end).getTime();
  const startMs = endMs - days * DAY_MS;
  const progress = (ms) => (ms - startMs) / (endMs - startMs); // 0 -> 1 across the window

  const pullRequests = [];
  const pipelineRuns = [];
  const deployments = [];
  const incidents = [];
  const merged = []; // { mergedAt, sourceRevision, commits }
  let runId = 1;
  let prNumber = 100;
  let deployId = 1;

  const addRun = (event, startedAt, minutes, sourceRevision) => {
    pipelineRuns.push({
      id: runId++,
      workflow: 'ci',
      event,
      startedAt: iso(startedAt),
      completedAt: iso(startedAt + minutes * 60_000),
      conclusion: 'success',
      attempt: rnd() < 0.09 - 0.04 * progress(startedAt) ? 2 : 1,
      sourceRevision,
    });
  };

  // --- Pull requests, CI and staging deploys -------------------------------
  for (let day = 0; day < days; day += 1) {
    const dayMs = startMs + day * DAY_MS;
    const weekday = new Date(dayMs).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (let i = poisson(3.2); i > 0; i -= 1) {
      const createdAt = dayMs + (9 + rnd() * 8) * HOUR_MS;
      const reviewMedian = 6 - 3 * progress(createdAt);
      const firstReviewAt = createdAt + lognormal(reviewMedian, 0.9) * HOUR_MS;
      const mergedAt = firstReviewAt + lognormal(1.5, 0.7) * HOUR_MS;
      if (mergedAt > endMs) continue;
      const commits = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
        sha: sha(),
        authoredAt: iso(createdAt - rnd() * 30 * HOUR_MS),
        bot: false,
      }));
      pullRequests.push({ number: prNumber++, createdAt: iso(createdAt), firstReviewAt: iso(firstReviewAt), mergedAt: iso(mergedAt), bot: false });
      for (let r = 1 + Math.floor(rnd() * 3); r > 0; r -= 1) {
        const ciMinutes = Math.max(4, 8 + 3 * normal() + (rnd() < 0.12 ? 9 : 0));
        addRun('pull_request', createdAt + rnd() * (mergedAt - createdAt), ciMinutes, null);
      }
      const sourceRevision = sha();
      const pushMinutes = Math.max(8, 15 + 3 * normal());
      addRun('push', mergedAt, pushMinutes, sourceRevision);
      const stagingAt = mergedAt + (pushMinutes + 3 + rnd() * 6) * 60_000;
      deployments.push({ id: `stg-${deployId++}`, environment: 'staging', deployedAt: iso(stagingAt), status: 'success', sourceRevision, rework: false, changes: [] });
      merged.push({ stagingAt, sourceRevision, commits });
    }

    // Dependabot: grouped weekly-ish updates.
    for (let i = poisson(1.1); i > 0; i -= 1) {
      const createdAt = dayMs + (6 + rnd() * 2) * HOUR_MS;
      const mergedAt = createdAt + lognormal(20, 0.6) * HOUR_MS;
      if (mergedAt < endMs) {
        pullRequests.push({ number: prNumber++, createdAt: iso(createdAt), firstReviewAt: iso(mergedAt - HOUR_MS / 4), mergedAt: iso(mergedAt), bot: true });
      }
    }
  }

  // --- Production promotions ------------------------------------------------
  merged.sort((a, b) => a.stagingAt - b.stagingAt);
  let cursor = 0;
  let pending = [];
  const prodDeploy = (deployedAt, status, sourceRevision, changes, rework = false) => {
    const d = { id: `prd-${deployId++}`, environment: 'production', deployedAt: iso(deployedAt), status, sourceRevision, rework, changes };
    deployments.push(d);
    return d;
  };

  for (let day = 0; day < days; day += 1) {
    const dayMs = startMs + day * DAY_MS;
    const weekday = new Date(dayMs).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const hour of [10, 15]) {
      const promoteAt = dayMs + hour * HOUR_MS;
      while (cursor < merged.length && merged[cursor].stagingAt <= promoteAt) pending.push(merged[cursor++]);
      if (pending.length === 0 || rnd() < 0.35) continue;
      const approvalWait = lognormal(3 - 1.5 * progress(promoteAt), 0.7) * HOUR_MS;
      const deployedAt = promoteAt + approvalWait;
      if (deployedAt > endMs) continue;
      const latest = pending[pending.length - 1];
      const changes = pending.flatMap((m) => m.commits);
      pending = [];

      if (rnd() < 0.03) {
        prodDeploy(deployedAt, 'failure', latest.sourceRevision, []);
        prodDeploy(deployedAt + lognormal(0.75, 0.4) * HOUR_MS, 'success', latest.sourceRevision, changes);
        continue;
      }
      const d = prodDeploy(deployedAt, 'success', latest.sourceRevision, changes);
      if (rnd() < 0.09 - 0.04 * progress(deployedAt)) {
        const openedAt = deployedAt + (0.5 + rnd() * 5) * HOUR_MS;
        const resolvedAt = openedAt + lognormal(1.6 - 0.6 * progress(openedAt), 0.7) * HOUR_MS;
        incidents.push({
          id: `INC-${incidents.length + 1}`,
          openedAt: iso(openedAt),
          resolvedAt: resolvedAt < endMs ? iso(resolvedAt) : null,
          severity: rnd() < 0.3 ? 'sev2' : 'sev3',
          deploymentId: rnd() < 0.6 ? d.id : null,
        });
        if (rnd() < 0.5 && resolvedAt < endMs) {
          const hotfix = [{ sha: sha(), authoredAt: iso(openedAt + 0.3 * HOUR_MS), bot: false }];
          prodDeploy(resolvedAt, 'success', sha(), hotfix, true);
        }
      }
    }
  }

  // A couple of incidents unrelated to any deployment (infra, upstream).
  for (let i = 0; i < 2; i += 1) {
    const openedAt = startMs + rnd() * (endMs - startMs - DAY_MS);
    incidents.push({ id: `INC-${incidents.length + 1}`, openedAt: iso(openedAt), resolvedAt: iso(openedAt + lognormal(2) * HOUR_MS), severity: 'sev3', deploymentId: null });
  }

  const byTime = (k) => (a, b) => new Date(a[k]) - new Date(b[k]);
  return {
    schemaVersion: SCHEMA_VERSION,
    repo,
    source: 'synthetic',
    generatedAt: new Date(endMs).toISOString(),
    window: { start: iso(startMs), end: iso(endMs), days },
    deployments: deployments.sort(byTime('deployedAt')),
    incidents: incidents.sort(byTime('openedAt')),
    pipelineRuns: pipelineRuns.sort(byTime('startedAt')),
    pullRequests: pullRequests.sort(byTime('createdAt')),
    notes: [`Synthetic dataset, seed ${seed}.`],
  };
}
