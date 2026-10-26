# 0009. DORA metrics from pipeline-emitted events over a 90-day window

- Status: Accepted
- Date: 2026-10-25

## Context

The pipeline must report DORA metrics for up to 90 days of data and recommend
toil reduction. DORA metrics are only trustworthy if the underlying events
(deployed, failed, recovered) are recorded **by the system**, not typed in by
people, and if each definition is explicit.

## Options considered

Deployment event source:

| Option | Pros | Cons |
|---|---|---|
| **Argo CD Notifications writes GitHub Deployments on sync** | Timestamp = when the cluster actually converged; success/failure from the real sync; no extra service | Needs a GitHub App and an Argo CD secret; one more integration to keep working |
| CI job success = deployment | Easy | With GitOps, CI finishing is not the deploy; overstates frequency, understates lead time |
| Merge commit time on the production overlay | Always available | Ignores sync time and sync failures |

Metric platform:

| Option | Pros | Cons |
|---|---|---|
| **Small in-repo collector + report (Node, zero deps)** | Transparent definitions; testable; runs in Actions with `GITHUB_TOKEN`; no hosting | We maintain it; no long-term warehouse |
| Four Keys / Apache DevLake | Dashboards, multiple sources | A service and a database to run; heavier than the problem |
| SaaS (LinearB, Sleuth, ...) | Polished | Cost; data leaves the org; opaque definitions |

## Decision

- **Primary deployment source:** GitHub Deployments for environment
  `production`, created by Argo CD Notifications (`on-deployed`,
  `on-sync-failed`, once per revision).
- **Fallback:** if no Deployments exist, commits that changed
  `deploy/overlays/production/release.json`, with deploy time = merge time.
  The report notes the fallback.
- **Exact lead time:** `release.json` records the source revision. The
  collector compares consecutive production source revisions and measures
  every human commit (bots and `[skip ci]` excluded) to the first production
  deploy that contained it.
- **Incidents** are GitHub issues labelled `incident` (template provided). An
  optional `Deployment: <id|sha>` line attributes them. Otherwise the most
  recent production deploy within 24h is assumed, and the report shows how
  many were inferred.
- **Five metrics:** deployment frequency, change lead time, change fail rate,
  failed deployment recovery time, and deployment rework rate (hotfix or
  revert deploys).
- **Window:** a rolling window, **capped at 90 days** in code. The daily
  workflow keeps every report (JSON + markdown) as an artifact for **90 days**,
  so any report from the last quarter can be reproduced.
- **Toil analysis** runs on the same dataset: CI re-runs, PR feedback time,
  review wait, promotion wait, bot PR volume, batch size, and failure toil.
  Recommendations are ranked, and the cost model is printed and overridable.

## Trade-offs and consequences

- **Why 90 days:** long enough to smooth weekly noise and cover a quarter's
  planning cycle. Short enough that the GitHub API cost stays inside a
  bounded request budget (800 by default, under the 1,000/hour
  `GITHUB_TOKEN` limit). Older trends are not stored. If quarter-over-quarter
  history matters, export `metrics.json` to a warehouse.
- **Runs out of budget → fails.** The collector fails rather than reporting
  partial numbers, which would look plausible and be wrong.
- **Incident attribution by time window is a heuristic.** Explicit
  `Deployment:` lines are better, and the report counts inferred
  attributions separately.
- **Performance bands are orientation only.** The report labels bands with
  the 2023 DORA thresholds. DORA's later reports cluster teams differently
  each year, so they should not be treated as grades.
- **Single-team, single-service scope.** Multiple services would need the
  dataset keyed by service.

## Revisit when

- More than one service or repository needs combined metrics. Then a shared
  store and a platform like DevLake becomes worth running.
- The request budget is hit regularly.
