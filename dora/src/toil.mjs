// Toil and flow analysis: turns pipeline/review/promotion data into ranked,
// actionable recommendations.
//
// Two kinds of waste are distinguished because they are fixed differently:
//   toil      - repetitive manual work (re-running jobs, clicking promote,
//               merging bot PRs). Measured in engineer-hours per month.
//   flow      - waiting (review queues, slow CI, promotion delay). Measured
//               in lead-time hours; nobody is busy, but changes sit idle.
//   stability - failure-driven work (incidents, failed deploys).
//
// Every cost estimate is derived from the constants in DEFAULT_COSTS. They are
// deliberately simple, printed in the report, and overridable via
// --costs <file.json>, so a team can calibrate them instead of trusting them.
import { DAY_MS, hoursBetween, median, percentile, ratio } from './stats.mjs';

export const DEFAULT_COSTS = {
  rerunMinutes: 15, // context switch + babysitting per manual CI re-run
  promotionMinutes: 10, // reviewing and merging one production promotion PR
  botPrMinutes: 5, // reviewing and merging one dependency-update PR
  incidentResponders: 2, // people engaged per incident for its duration
  waitAttentionFactor: 0.25, // share of CI wait time that blocks the author
};

export const TARGETS = {
  rerunRate: 0.05,
  prCiP90Minutes: 10, // pipeline SLO: PR feedback (docs/observability.md)
  mainToStagingP90Minutes: 30, // pipeline SLO: merge -> staging
  reviewWaitP50Hours: 4,
  promotionWaitP50Hours: 24,
  batchSizeMedian: 10,
  changeFailRate: 0.15,
  recoveryP50Hours: 1,
  reworkRate: 0.1,
};

const EFFORT_WEIGHT = { S: 1, M: 2, L: 4 };

function monthsIn(window) {
  return Math.max((new Date(window.end) - new Date(window.start)) / (30 * DAY_MS), 1 / 30);
}

const durationMinutes = (r) => (new Date(r.completedAt) - new Date(r.startedAt)) / 60_000;

/** Raw signals, independent of any recommendation logic. */
export function computeSignals(dataset, metrics, costs = DEFAULT_COSTS) {
  const runs = dataset.pipelineRuns ?? [];
  const ciRuns = runs.filter((r) => r.workflow === 'ci');
  const prRuns = ciRuns.filter((r) => r.event === 'pull_request' && r.completedAt);
  const reruns = runs.filter((r) => r.attempt > 1);
  const months = monthsIn(dataset.window);

  const prs = (dataset.pullRequests ?? []).filter((p) => p.mergedAt);
  const humanPrs = prs.filter((p) => !p.bot);
  const reviewWaits = humanPrs.filter((p) => p.firstReviewAt).map((p) => hoursBetween(p.createdAt, p.firstReviewAt));

  // Promotion wait: staging deploy -> production deploy of the same source.
  const stagingAt = new Map();
  for (const d of dataset.deployments.filter((x) => x.environment === 'staging' && x.status === 'success')) {
    if (d.sourceRevision && !stagingAt.has(d.sourceRevision)) stagingAt.set(d.sourceRevision, d.deployedAt);
  }
  const prodDeploys = dataset.deployments.filter((x) => x.environment === 'production' && x.status === 'success');
  const promotionWaits = prodDeploys
    .filter((d) => stagingAt.has(d.sourceRevision))
    .map((d) => hoursBetween(stagingAt.get(d.sourceRevision), d.deployedAt))
    .filter((h) => h >= 0);

  // Merge -> staging: from the main-branch CI run start to the staging deploy.
  const mainToStaging = ciRuns
    .filter((r) => r.event === 'push' && r.sourceRevision && stagingAt.has(r.sourceRevision))
    .map((r) => (new Date(stagingAt.get(r.sourceRevision)) - new Date(r.startedAt)) / 60_000)
    .filter((m) => m >= 0);

  const incidents = (dataset.incidents ?? []).filter((i) => i.resolvedAt);
  const incidentHours = incidents.reduce((s, i) => s + hoursBetween(i.openedAt, i.resolvedAt), 0);

  return {
    months,
    runs: runs.length,
    rerunRate: ratio(reruns.length, runs.length),
    rerunsPerMonth: reruns.length / months,
    prCiP50Minutes: median(prRuns.map(durationMinutes)),
    prCiP90Minutes: percentile(prRuns.map(durationMinutes), 90),
    prRunsPerMonth: prRuns.length / months,
    mainToStagingP90Minutes: percentile(mainToStaging, 90),
    reviewWaitP50Hours: median(reviewWaits),
    reviewWaitP90Hours: percentile(reviewWaits, 90),
    humanPrsPerMonth: humanPrs.length / months,
    botPrsPerMonth: prs.filter((p) => p.bot).length / months,
    promotionWaitP50Hours: median(promotionWaits),
    promotionsPerMonth: prodDeploys.length / months,
    batchSizeMedian: metrics.overall.leadTime.medianBatchSize,
    changeFailRate: metrics.overall.changeFailRate.rate,
    recoveryP50Hours: metrics.overall.recoveryTime.p50Hours,
    reworkRate: metrics.overall.reworkRate.rate,
    incidentPersonHoursPerMonth: (incidentHours * costs.incidentResponders) / months,
  };
}

function severity(observed, target, higherIsWorse = true) {
  if (observed === null || observed === undefined) return null;
  const r = higherIsWorse ? observed / target : target / observed;
  if (r >= 2) return 'P1';
  if (r > 1) return 'P2';
  if (r >= 0.8) return 'P3';
  return null;
}

/** Ranked recommendations. Each rule fires only when its signal is present. */
export function recommend(signals, costs = DEFAULT_COSTS, targets = TARGETS) {
  const recs = [];
  const add = (r) => {
    if (!r.priority) return;
    const impact = (r.toilHoursPerMonth ?? 0) + (r.leadTimeHoursSaved ?? 0) * 0.1;
    recs.push({ ...r, score: impact / EFFORT_WEIGHT[r.effort] });
  };

  add({
    id: 'flaky-ci',
    category: 'toil',
    title: 'Quarantine and fix flaky CI jobs',
    priority: severity(signals.rerunRate, targets.rerunRate),
    evidence: `${(signals.rerunRate * 100).toFixed(1)}% of workflow runs were manually re-run (${signals.rerunsPerMonth.toFixed(1)}/month); target <= ${targets.rerunRate * 100}%.`,
    toilHoursPerMonth: (signals.rerunsPerMonth * costs.rerunMinutes) / 60,
    effort: 'M',
    actions: [
      'Tag re-run jobs automatically (run_attempt > 1) and review the top offenders weekly.',
      'Move tests that fail non-deterministically into a non-blocking quarantine job with an owner and an expiry date.',
      'Replace sleeps/timing assertions with deterministic waits; the reference app tests bind port 0 for this reason.',
    ],
  });

  if (signals.prCiP90Minutes !== null) {
    const over = Math.max(signals.prCiP90Minutes - targets.prCiP90Minutes, 0);
    add({
      id: 'slow-pr-feedback',
      category: 'flow',
      title: 'Shorten pull-request CI feedback',
      priority: severity(signals.prCiP90Minutes, targets.prCiP90Minutes),
      evidence: `PR CI p90 is ${signals.prCiP90Minutes.toFixed(1)} min (p50 ${signals.prCiP50Minutes.toFixed(1)}); pipeline SLO is p90 <= ${targets.prCiP90Minutes} min.`,
      toilHoursPerMonth: (signals.prRunsPerMonth * over * costs.waitAttentionFactor) / 60,
      leadTimeHoursSaved: (signals.prRunsPerMonth * over) / 60,
      effort: 'M',
      actions: [
        'Run independent jobs in parallel (already the default layout in ci.yml) and keep the critical path to test -> build.',
        'Cache the Docker build (type=gha cache is configured) and the OpenTofu provider plugins.',
        'Skip image build/SBOM/scan on PRs that only touch docs (paths filter) while keeping required checks green.',
      ],
    });
  }

  add({
    id: 'slow-main-to-staging',
    category: 'flow',
    title: 'Speed up merge-to-staging',
    priority: severity(signals.mainToStagingP90Minutes, targets.mainToStagingP90Minutes),
    evidence: `Merge -> staging p90 is ${signals.mainToStagingP90Minutes?.toFixed(1)} min; pipeline SLO is <= ${targets.mainToStagingP90Minutes} min.`,
    leadTimeHoursSaved:
      ((signals.mainToStagingP90Minutes ?? 0) - targets.mainToStagingP90Minutes) / 60 * signals.promotionsPerMonth,
    effort: 'S',
    actions: [
      'Lower Argo CD reconciliation (timeout.reconciliation) or add a GitHub webhook to Argo CD so syncs start on push rather than on poll.',
      'Check the slsa-github-generator and verify jobs for registry rate limiting; they run serially after build.',
    ],
  });

  add({
    id: 'review-latency',
    category: 'flow',
    title: 'Reduce time waiting for first review',
    priority: severity(signals.reviewWaitP50Hours, targets.reviewWaitP50Hours),
    evidence: `Median time to first review is ${signals.reviewWaitP50Hours?.toFixed(1)}h (p90 ${signals.reviewWaitP90Hours?.toFixed(1)}h); target <= ${targets.reviewWaitP50Hours}h.`,
    leadTimeHoursSaved:
      Math.max((signals.reviewWaitP50Hours ?? 0) - targets.reviewWaitP50Hours, 0) * signals.humanPrsPerMonth,
    effort: 'S',
    actions: [
      'Agree a team review SLO (e.g. first response within 4 working hours) and make the queue visible in standup.',
      'Keep PRs small: the median batch per deploy is a leading indicator of review size.',
      'Use CODEOWNERS with a rotation/team alias instead of individual reviewers.',
    ],
  });

  add({
    id: 'manual-promotion',
    category: 'toil',
    title: 'Automate production promotion behind SLO gates',
    priority: severity(signals.promotionWaitP50Hours, targets.promotionWaitP50Hours),
    evidence: `Median staging -> production wait is ${signals.promotionWaitP50Hours?.toFixed(1)}h across ${signals.promotionsPerMonth.toFixed(1)} promotions/month; target <= ${targets.promotionWaitP50Hours}h.`,
    toilHoursPerMonth: (signals.promotionsPerMonth * costs.promotionMinutes) / 60,
    leadTimeHoursSaved:
      Math.max((signals.promotionWaitP50Hours ?? 0) - targets.promotionWaitP50Hours, 0) * signals.promotionsPerMonth,
    effort: 'L',
    actions: [
      'Schedule the promote workflow (e.g. hourly in business hours) so a PR is always waiting with the latest verified staging build.',
      'Adopt Argo Rollouts with an AnalysisTemplate that queries the burn-rate recording rules; auto-merge the promotion PR when staging has soaked for N hours without budget burn.',
      'Keep the CODEOWNERS approval for changes to policy/infra; relax it for digest-only promotions.',
    ],
  });

  add({
    id: 'dependency-pr-toil',
    category: 'toil',
    title: 'Auto-merge low-risk dependency updates',
    priority: signals.botPrsPerMonth >= 8 ? (signals.botPrsPerMonth >= 20 ? 'P2' : 'P3') : null,
    evidence: `${signals.botPrsPerMonth.toFixed(1)} bot PRs merged per month, each reviewed by hand.`,
    toilHoursPerMonth: (signals.botPrsPerMonth * costs.botPrMinutes) / 60,
    effort: 'S',
    actions: [
      'Group Dependabot updates per ecosystem (configured in .github/dependabot.yml) to cut PR count.',
      'Enable auto-merge for patch/minor updates of GitHub Actions and base-image digests when all required checks pass.',
      'Keep majors and Helm chart bumps manual; they change behaviour.',
    ],
  });

  add({
    id: 'large-batches',
    category: 'flow',
    title: 'Ship smaller batches',
    priority: severity(signals.batchSizeMedian, targets.batchSizeMedian),
    evidence: `Median ${signals.batchSizeMedian ?? 'n/a'} human commits per production deployment; target <= ${targets.batchSizeMedian}.`,
    effort: 'M',
    leadTimeHoursSaved: 0,
    actions: [
      'Promote more often; batch size falls automatically when promotion is cheap (see manual-promotion).',
      'Use feature flags to merge incomplete work dark instead of holding long-lived branches.',
    ],
  });

  add({
    id: 'change-failures',
    category: 'stability',
    title: 'Catch failing changes before they reach production',
    priority: severity(signals.changeFailRate, targets.changeFailRate),
    evidence: `Change fail rate is ${((signals.changeFailRate ?? 0) * 100).toFixed(1)}%; target <= ${targets.changeFailRate * 100}%.`,
    toilHoursPerMonth: signals.incidentPersonHoursPerMonth,
    effort: 'L',
    actions: [
      'Introduce canary analysis (Argo Rollouts) so bad builds abort on SLO burn before full rollout.',
      'Write a failing test for each incident root cause before closing the incident issue.',
      'Run Kyverno policies in CI (kyverno test) so admission rejections are caught pre-merge.',
    ],
  });

  add({
    id: 'slow-recovery',
    category: 'stability',
    title: 'Make rollback a one-step, rehearsed action',
    priority: severity(signals.recoveryP50Hours, targets.recoveryP50Hours),
    evidence: `Median failed-deployment recovery time is ${signals.recoveryP50Hours?.toFixed(1)}h; target <= ${targets.recoveryP50Hours}h.`,
    toilHoursPerMonth: signals.incidentPersonHoursPerMonth * 0.5,
    effort: 'M',
    actions: [
      'Follow docs/runbooks/rollback.md: revert the promotion commit; Argo CD restores the previous digest in minutes.',
      'Page on burn rate (already configured) rather than on symptoms reported by users.',
      'Rehearse the rollback in staging once per sprint; time it.',
    ],
  });

  add({
    id: 'rework',
    category: 'stability',
    title: 'Reduce unplanned (rework) deployments',
    priority: severity(signals.reworkRate, targets.reworkRate),
    evidence: `${((signals.reworkRate ?? 0) * 100).toFixed(1)}% of production deployments were hotfixes or reverts; target <= ${targets.reworkRate * 100}%.`,
    effort: 'M',
    leadTimeHoursSaved: 0,
    actions: [
      'Review hotfix causes monthly; recurring categories become tests or policy checks.',
      'Make reverts the default response (cheaper and safer than forward hotfixes under pressure).',
    ],
  });

  const order = { P1: 0, P2: 1, P3: 2 };
  return recs.sort((a, b) => order[a.priority] - order[b.priority] || b.score - a.score);
}

export function analyzeToil(dataset, metrics, { costs = DEFAULT_COSTS, targets = TARGETS } = {}) {
  const signals = computeSignals(dataset, metrics, costs);
  const recommendations = recommend(signals, costs, targets);
  const toilHoursPerMonth = recommendations
    .filter((r) => r.category === 'toil')
    .reduce((s, r) => s + (r.toilHoursPerMonth ?? 0), 0);
  return { signals, recommendations, totals: { toilHoursPerMonth }, costs, targets };
}
