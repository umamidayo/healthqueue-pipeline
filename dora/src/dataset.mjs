// Normalized dataset contract shared by the GitHub collector, the synthetic
// generator and the metric engine. Keeping collection and computation apart
// means metrics are unit-testable without network access and other sources
// (GitLab, Jira, PagerDuty) can be added by writing a new collector only.
//
// {
//   schemaVersion: 1,
//   repo: "owner/name",
//   source: "github" | "synthetic",
//   generatedAt: ISO,
//   window: { start: ISO, end: ISO, days: number },
//   deployments: [{
//     id, environment: "staging" | "production", deployedAt: ISO,
//     status: "success" | "failure", sourceRevision: sha | null,
//     rework: boolean,                     // unplanned fix / revert deploy
//     changes: [{ sha, authoredAt: ISO, bot: boolean }]   // production only
//   }],
//   incidents: [{ id, openedAt, resolvedAt | null, severity, deploymentId | null }],
//   pipelineRuns: [{ id, workflow, event, startedAt, completedAt, conclusion, attempt }],
//   pullRequests: [{ number, createdAt, firstReviewAt | null, mergedAt, bot: boolean }],
//   notes: [string]                        // collection caveats surfaced in the report
// }

export const SCHEMA_VERSION = 1;
export const MAX_WINDOW_DAYS = 90;

export function clampWindowDays(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) throw new Error('--days must be a positive integer');
  if (n > MAX_WINDOW_DAYS) {
    throw new Error(`--days is capped at ${MAX_WINDOW_DAYS} (got ${n}); see docs/adr/0009-dora-measurement.md`);
  }
  return n;
}

export function validateDataset(ds) {
  const problems = [];
  if (ds?.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!ds?.window?.start || !ds?.window?.end) problems.push('window.start and window.end are required');
  if (ds?.window?.days > MAX_WINDOW_DAYS) problems.push(`window.days exceeds ${MAX_WINDOW_DAYS}`);
  for (const key of ['deployments', 'incidents', 'pipelineRuns', 'pullRequests']) {
    if (!Array.isArray(ds?.[key])) problems.push(`${key} must be an array`);
  }
  for (const d of ds?.deployments ?? []) {
    if (!['staging', 'production'].includes(d.environment)) problems.push(`deployment ${d.id}: bad environment`);
    if (!['success', 'failure'].includes(d.status)) problems.push(`deployment ${d.id}: bad status`);
    if (Number.isNaN(Date.parse(d.deployedAt))) problems.push(`deployment ${d.id}: bad deployedAt`);
  }
  if (problems.length) throw new Error(`invalid dataset:\n  - ${problems.join('\n  - ')}`);
  return ds;
}
