# 0010. SLOs with multi-window, multi-burn-rate alerts generated from a spec

- Status: Accepted
- Date: 2026-10-25

## Context

The project needs an observability plan with defined SLIs and SLOs. Alerting
must page a human only when users are being hurt badly enough to justify
waking someone. Threshold alerts like "error rate > 1%" are noisy at low
traffic and slow at high severity.

Burn-rate alerting (Google SRE Workbook, "Alerting on SLOs") solves both
problems. It is also repetitive: per SLO it needs seven recording windows and
four alert conditions, which are easy to typo.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Small in-repo generator from a JSON spec** (`scripts/gen-slo-rules.mjs`) | No extra tooling; output is plain PrometheusRule YAML that is reviewed and unit-tested; CI fails on drift | We maintain ~150 lines of generator |
| Sloth | Mature SLO generator; same math | Extra binary in CI; its own spec format |
| Pyrra | Generator plus a UI and operator | Another controller in the cluster |
| Hand-written rules | No tooling | Error-prone repetition; no single place that states the objective |
| Static threshold alerts | Familiar | Pages on blips; misses slow burns |

## Decision

- **Spec:** `observability/slo-spec.json` (service, 30-day window, per-SLO
  objective, and error/total queries).
- **Generated** `deploy/components/monitoring/slo-rules.yaml`:
  - recording rules for 5m, 30m, 1h, 2h, 6h, 1d, 3d and 30d error ratios,
  - error-budget-remaining,
  - two alerts per SLO:

| Alert | Condition (both windows must exceed) | Budget consumed | Severity |
|---|---|---|---|
| `...BudgetBurnFast` | 14.4x over 1h **and** 5m, *or* 6x over 6h **and** 30m | 2% in 1h / 5% in 6h | page |
| `...BudgetBurnSlow` | 3x over 1d **and** 2h, *or* 1x over 3d **and** 6h | 10% in 1d / 10% in 3d | ticket |

- **The short window** (1/12 of the long one) makes alerts stop soon after the
  problem stops.
- **Tested:** `observability/tests/*.test.yaml` are promtool unit tests. They
  assert that a 9% error rate pages, 4xx and healthy traffic stay silent,
  slow responses page on latency, and a missing scrape target pages. CI runs
  them; `check.ps1` runs them on Windows.
- **Zero, not absent:** the ratio rules use `or 0 * total`, so a service with
  no errors yet reports 0 instead of no data.

## Trade-offs and consequences

- **Low traffic:** at very low request rates, one failure is a large ratio, so
  a quiet staging environment can page on a single 5xx. A minimum-traffic
  guard or synthetic probes (Phase 3 in docs/observability.md) address this.
  The reference does not add a guard, so the math stays readable.
- **Severity routing is left open:** `severity` labels route in
  Alertmanager. Receivers are empty stubs; wire PagerDuty or Slack per
  environment (docs/observability.md).
- **Retention:** the 30d recording rule needs 30 days of raw samples.
  Production Prometheus retention is set to 35d.

## Revisit when

- More than a few services need SLOs. Adopt Sloth or Pyrra rather than grow the
  generator.
- Traffic is low enough that burn rates flap. Add probe-based SLIs or
  request-count guards.
