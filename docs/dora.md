# DORA metrics and toil reduction

The pipeline measures its own delivery performance from events it emits
itself, over a rolling window of **up to 90 days**, and turns the result into
ranked toil-reduction recommendations. Design rationale: ADR 0009.

- **Run it:** the `dora` workflow runs daily. The report is in the run summary,
  and the JSON plus markdown are kept as an artifact for 90 days.
- **Run it locally:** `node dora/cli.mjs collect --repo owner/name --days 90`
  (needs `GITHUB_TOKEN`).
- **See an example:** [docs/dora/sample/report.md](dora/sample/report.md),
  generated from a deterministic **synthetic** dataset
  (`npm run sample` in `dora/`).

## Definitions

All metrics are for the **production** environment.

| Metric | Definition used here | Data source |
|---|---|---|
| **Deployment frequency** | Successful production deployments per day / week, plus distinct days with a deploy | Promotion commits to `deploy/overlays/production/release.json` (default); GitHub Deployments from Argo CD Notifications (opt-in, `--deployment-source deployments`) |
| **Change lead time** | For each human-authored commit: author time to the first successful production deploy containing it. Reported as p50 and p90 | `Source-Revision:` trailer (or `release.json`) at each deploy; compare API between consecutive revisions; bots and `[skip ci]` commits excluded |
| **Change fail rate** | (failed syncs + deploys that caused an incident) / attempted deploys | Deployment statuses; issues labelled `incident` |
| **Failed deployment recovery time** | Incident open to close for deploy-attributed incidents, plus failed sync to next successful deploy. p50 and p90 | Same |
| **Deployment rework rate** | Deploys whose changes include a `revert`/`hotfix` commit / successful deploys | Commit messages in the deploy's change range |

**Incident attribution:**

- An incident issue may contain `Deployment: <deployment id | sha prefix>`,
  which is an explicit attribution.
- Without it, the incident is attributed to the latest successful production
  deploy in the preceding 24h (`--attribution-hours`), an inferred
  attribution.
- Incidents with no deploy in range count toward the incident total, but not
  toward the change fail rate.

**Bands:**

- The report shows the 2023 DORA performance bands (elite/high/medium/low) as
  orientation only. DORA's later reports cluster teams differently each year.
- Use the trend (first 30 days vs last 30 days, and the weekly table)
  rather than the band.

## Why the numbers can be trusted

- No human logs a deployment. The promote workflow's commit is the record.
  It is made only after approval and verification, and Argo CD applies it
  within minutes. Failed syncs are not counted in commit mode (they still
  alert via `ArgoCDSyncFailing`); opt into GitHub Deployments to count them
  (ADR 0013).
- `release.json` ties every production digest to the exact source commit it
  was built from. Lead time is measured, not estimated from merge times.
- **Missing data shows as missing.** Metrics with no data are `n/a`, not 0,
  and if the API budget runs out the job fails instead of publishing partial
  numbers.
- The collector and metric engine are covered by tests (`dora/test/`),
  including a mocked GitHub API, and the 90-day cap is enforced before any
  request is made.

## The 90-day window

- **Window:** `--days` accepts 1-90; values over 90 are rejected
  (`dataset.mjs`).
- **Retention:** each daily run keeps `dataset.json`, `metrics.json` and
  `report.md` for 90 days, so any report from the last quarter can be
  reproduced.
- **Trend:** the report includes a weekly table (13 rows for 90 days) and a
  first-30-days vs last-30-days comparison for every metric.
- **Older history:** to keep it, export `metrics.json` to a warehouse. The
  window is capped to keep API cost bounded (800 requests by default).

## Toil already removed by the pipeline design

| Manual task in a typical setup | What replaces it here |
|---|---|
| Building and pushing images by hand or with ad-hoc scripts | `ci / build` on every merge |
| Editing image tags in manifests to deploy | `promote-staging` commits the digest; an approved `promote` run commits production |
| `kubectl apply` / `helm upgrade` from a laptop | Argo CD auto-sync with self-heal |
| Checking a release is signed before approving | Re-verification runs after approval and before the commit; the log is in the run summary |
| Logging deployments in a spreadsheet for metrics | Promotion commits with `Source-Revision:` trailers |
| Rebuilding per environment | One digest flows staging to production |
| Rolling back by redeploying an old build | `git revert` of the promotion; previous digest is still admissible |
| Hand-writing burn-rate alert rules | Generated from `slo-spec.json`, with unit tests |
| Checking that manifests and policies are valid after edits | kubeconform, promtool, kyverno test in CI and `check.ps1` |
| Updating pins (actions, digests, providers) | Dependabot, grouped |
| Bootstrapping a cluster by following a wiki | `tofu apply` (prod) / `up.ps1` (local) |

## Toil reduction recommendations (generated)

The report analyses the same dataset for toil (repetitive manual work, in
engineer-hours/month), flow (waiting, in change-hours) and stability, and
ranks recommendations:

- **P1:** signal at least 2x its target.
- **P2:** over target.
- **P3:** within 20% of target (watch).

Within a priority, rank is estimated impact per unit of effort.

| Rule | Signal | Target | Typical recommendation |
|---|---|---|---|
| `flaky-ci` | manual re-run rate | at most 5% | Quarantine flaky tests with an owner and expiry; deterministic waits |
| `slow-pr-feedback` | PR CI p90 | at most 10 min | Parallelise, cache, path-filter heavy jobs |
| `slow-main-to-staging` | merge to staging p90 | at most 30 min | Argo CD webhook instead of polling |
| `review-latency` | first-review wait p50 | at most 4h | Team review SLO; smaller PRs; CODEOWNERS team alias |
| `manual-promotion` | staging to production wait p50 | at most 24h | Scheduled promotion; then SLO-gated canary + auto-merge |
| `dependency-pr-toil` | bot PRs merged/month | auto-merge | Grouped updates + auto-merge for patch/minor |
| `large-batches` | human commits per deploy (median) | at most 10 | Promote more often; feature flags |
| `change-failures` | change fail rate | at most 15% | Canary analysis; a failing test per incident; policy checks pre-merge |
| `slow-recovery` | recovery p50 | at most 1h | Rehearsed `git revert` rollback; page on burn rate |
| `rework` | rework rate | at most 10% | Monthly hotfix cause review; revert-first culture |

**Cost model** (printed in every report; override with `--costs file.json`):

| Constant | Default |
|---|---|
| Manual re-run | 15 min |
| Starting and approving one promotion | 10 min |
| Merging one bot PR | 5 min |
| Responders per incident | 2 |
| Share of CI wait that blocks the author | 0.25 |

Calibrate these with the team. The ranking matters more than the absolute
hours.

### What the sample report recommends, and why

From the synthetic 90-day sample ([report](dora/sample/report.md)):

1. **Shorten PR CI feedback (P2).** p90 is 16 minutes against a 10-minute
   SLO. About 3.6 engineer-h/month are lost to waiting, and changes spend
   about 14 more hours/month idle.
2. **Auto-merge dependency updates (P2, effort S).** 26 bot PRs/month merged
   by hand. That is about 2.2 h/month for a one-time configuration change, so
   it is the best ratio in the report.
3. **Review latency (P2).** Median first review is 4.3h, slightly over the
   4h target, and the p90 is 16h. The p90 is where lead time is lost.
4. **Flaky CI (P2).** A 7.4% re-run rate costs about 3.9 h/month.

Below those, rollback speed, batch size and merge-to-staging are P3 (watch)
items, near their targets but not over.

## Recording incidents well

Use the **Incident** issue template:

- add the `incident` label (the template does this) and a `sev1`-`sev3`
  label,
- include a `Deployment:` line when the cause is known,
- **close the issue when service is restored,** not when follow-ups are done.
  Track follow-ups in separate issues.

## Data contract

`dora/src/dataset.mjs` documents the normalized schema. A new source (GitLab,
PagerDuty for incidents, Jira) only needs a collector that emits that shape.
The metrics, toil rules and report work unchanged.
