# Observability plan

What we measure, what we promise, how we find out when we break the promise,
and what we do about it. The SLO alerting design is in ADR 0010.

## Goals

1. Page a human **only** when users are being hurt fast enough to justify it.
2. Make every other degradation visible within a working day, as a ticket.
3. Measure the **delivery system** with the same rigour as the service. A
   pipeline that silently stops deploying is an outage of a different kind.
4. Everything here must work identically on a laptop (`scripts/local/*`).

## Signals

| Signal | Source | Collected by | Status |
|---|---|---|---|
| Metrics: RED (rate, errors, duration) per route, build info, process memory | `/metrics` (`app/src/metrics.js`) | Prometheus via ServiceMonitor (15s) | **Phase 1, in repo** |
| Metrics: Argo CD app health/sync, Kyverno admission, kube-state | Component exporters | kube-prometheus-stack | **Phase 1** |
| Logs: structured JSON, one line per request (method, route template, status, duration) | stdout | Cluster log agent (not shipped in this repo) | **Phase 1** (format); Phase 2 (aggregation) |
| Pipeline events: runs, re-runs, deploys, incidents, reviews | GitHub API | DORA collector, daily | **Phase 1** |
| Traces | OpenTelemetry SDK | OTel Collector to Tempo/Jaeger | Phase 2 |
| Synthetic probes (outside-in availability) | blackbox-exporter | Prometheus | Phase 3 |

**Cardinality budget:** `route` is a template (unknown paths collapse to
`unmatched`), `code` is a status code, and `method` is an HTTP verb. No IDs,
no user input. That keeps the API to about 100 series per pod.

**Privacy:** the API never receives patient identifiers (ADR 0011). Logs and
metrics carry aggregates only, so nothing here is health data.

## Service SLIs and SLOs

Window: **30 days, rolling.** Scope: `/api/*` routes. Health, readiness and
metrics endpoints are excluded, since they are not user traffic.

| SLO | SLI (good / valid) | Objective | Error budget (30d) | PromQL source |
|---|---|---|---|---|
| **Availability** | requests not answered with 5xx / all requests | **99.5%** | 0.5% (~3h 36m of total outage) | `http_requests_total{code=~"5.."}` / `http_requests_total` |
| **Latency** | requests served in at most 300ms / all requests | **99%** | 1% | `http_request_duration_seconds_bucket{le="0.3"}` / `_count` |

Why these numbers:

- **99.5%** suits a decision-support tool. Clinicians fall back to triage
  judgement, so it is not a life-critical path. Higher targets would forbid
  the deploy cadence that keeps the service improving.
- **300ms** is what the estimate has to beat for a check-in screen to feel
  instant. The service does pure arithmetic, so p99 is normally single-digit
  milliseconds, and the target catches saturation (CPU throttling, GC) rather
  than code paths.
- **4xx responses are good events.** A rejected invalid request is the service
  working. Alert tests assert that 4xx traffic stays silent.

The source of truth is `observability/slo-spec.json`. Change the spec, run
`node scripts/gen-slo-rules.mjs`, and commit both files. CI fails if they
diverge.

## Delivery-system (pipeline) SLIs and SLOs

| SLO | SLI | Objective | Measured by |
|---|---|---|---|
| PR feedback | duration of `ci` runs on `pull_request` | p90 at most 10 min | DORA report (`prCiP90Minutes`) |
| Merge to staging | `ci` push run start to staging digest commit | p90 at most 30 min | DORA report (`mainToStagingP90Minutes`) |
| Deploy success | successful / attempted production syncs | 99% | DORA report (`changeFailRate.attempted`); `ArgoCDSyncFailing` |
| GitOps convergence | time an Application is OutOfSync | under 30 min | `ArgoCDAppOutOfSync` (ticket) |
| Workload health after deploy | time an Application is Degraded/Missing | under 10 min | `ArgoCDAppDegraded` (page) |
| Pipeline reliability | manual re-run rate | at most 5% | DORA report (`rerunRate`) |

## Alerting

Multi-window, multi-burn-rate alerts (Google SRE Workbook), generated for each
SLO:

| Alert | Fires when | Means | Severity | Time to fire at 100% errors |
|---|---|---|---|---|
| `HealthQueue<SLO>BudgetBurnFast` | 14.4x burn over 1h **and** 5m, *or* 6x over 6h **and** 30m | 2% of the month's budget gone in an hour | **page** | ~2-3 min |
| `HealthQueue<SLO>BudgetBurnSlow` | 3x over 1d **and** 2h, *or* 1x over 3d **and** 6h | on track to exhaust the budget | **ticket** | ~15-20 min |
| `HealthQueueTargetDown` | no API target up for 5m | metrics are blind | page | 5 min |
| `ArgoCDAppDegraded` | app Degraded/Missing for 10m | a deploy broke the workload | page | 10 min |
| `ArgoCDAppOutOfSync` | OutOfSync for 30m | Git and cluster disagree | ticket | 30 min |
| `ArgoCDSyncFailing` | more than 2 failed syncs in 30m | bad manifest or admission rejection | ticket | immediate |

Every alert carries `runbook_url`, which points at
[runbooks/slo-burn-rate.md](runbooks/slo-burn-rate.md) or
[runbooks/rollback.md](runbooks/rollback.md).

**Routing** is configured in kube-prometheus-stack values: `severity=page` goes
to receiver `page`, and `severity=ticket` goes to `ticket`. The receivers ship
empty. Wire them per environment:

- production `page` to PagerDuty or Opsgenie, with 24/7 rotation,
- staging `page` to a team Slack channel (staging pages should not wake anyone),
- `ticket` to the issue tracker or a daytime channel.

**Testing:** `observability/tests/*.test.yaml` are promtool unit tests. They
run in CI and in `scripts/check.ps1`, and a mutation check during development
confirmed they fail when thresholds are loosened. Locally,
`scripts/local/load.ps1 -ErrorPercent 20` fires the fast-burn page in about 5
minutes.

## Error budget policy

| Budget state (30d) | What happens |
|---|---|
| more than 50% remaining | Normal delivery |
| 25-50% remaining | The environment approver checks the staging SLO dashboard for burn since the build landed before approving a `promote` run |
| under 25% remaining | Only fixes and reliability work are promoted to production; feature promotions wait |
| exhausted | Production promotions frozen except for fixes; blameless postmortem; at least one reliability action item scheduled before the freeze lifts |
| one incident consumes more than 20% | Postmortem regardless of remaining budget |

The policy is enforced by the `production` environment approvers. The run
summary links the evidence. Automating it (failing the run when
`error_budget:remaining_ratio < 0.25`) is a small extension to
`promote.yml`.

## Dashboards

`deploy/components/monitoring/dashboard.json` is provisioned to Grafana by the
sidecar in every environment. Select the environment with the `namespace`
variable. Panels:

- 30-day availability and latency SLIs,
- budget remaining,
- burn rate (1h, 6h, 3d) with 1x = on budget,
- request rate by status,
- p50/p95/p99 latency,
- running versions (`healthqueue_build_info`), which shows a rollout in
  progress.

## Retention

| Data | Retention | Why |
|---|---|---|
| Prometheus (staging/production) | 35d | Must cover the 30d SLO window plus margin |
| Prometheus (local) | 7d | Laptop disk |
| DORA reports (Actions artifacts) | 90d | Matches the DORA window (ADR 0009) |
| SBOMs (Actions artifacts) | 90d | Audit requests; SBOM attestations live with the image indefinitely |

## Roadmap

- **Phase 2:**
  - OpenTelemetry tracing (SDK in the app, Collector as a DaemonSet). This
    adds the first runtime dependency, through the dependency-review gate.
  - Log aggregation (Loki or the platform's existing stack), keyed by the
    same `route` label as the metrics.
- **Phase 3:**
  - Synthetic probes from outside the cluster, measuring availability as
    users see it.
  - Request-count guards for low-traffic burn rates.
  - Argo Rollouts canary analysis on the burn-rate recording rules.
