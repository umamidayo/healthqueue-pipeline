# 0011. A stateless, zero-dependency reference workload

- Status: Accepted
- Date: 2026-10-25

## Context

The pipeline needs something real to build and deploy. The workload is not
the product; the pipeline is. The workload should:

- exercise every stage (tests, image, SBOM, scan, sign, deploy, SLOs) with
  real behaviour,
- scale horizontally, so the PDB, HPA and rolling updates mean something,
- not distract with business complexity, or with handling health data.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Stateless triage wait-time estimator (Node 24, standard library only)** | Real validation, real metrics, real errors; any replica serves any request; zero third-party packages to vet | Hand-rolled Prometheus exposition and a minimal lint step instead of established libraries |
| Stateful queue with in-memory store | More realistic for "HealthQueue" | Multiple replicas would hold different queues; would need Redis/Postgres, migrations and backups, which is out of scope |
| Express / Fastify + prom-client + ESLint | Familiar | Hundreds of transitive packages in the SBOM; more Dependabot toil; no added pipeline value |

## Decision

- The API estimates wait time from aggregate inputs (ESI acuity, patients
  ahead, clinicians on shift). **It never receives or stores patient
  identifiers,** so no health data enters the pipeline, the logs or the
  metrics.
- **Node.js standard library only.**
  - `node:http` for the server and `node:test` for tests and coverage.
  - A ~150-line Prometheus text-format implementation (`app/src/metrics.js`).
  - `node --check` as the lint step.
- **The 300ms histogram bucket is load-bearing** for the latency SLO, and a
  unit test guards it.
- **Production hygiene in the service:**
  - readiness that fails during shutdown,
  - a grace period before draining,
  - keep-alive longer than typical load-balancer idle timeouts,
  - body size limits,
  - bounded metric label cardinality (unknown paths collapse to `unmatched`).
- **Chaos hooks** (`x-chaos: error|slow`) let you exercise the burn-rate
  alerts locally. They only take effect when `CHAOS_ENABLED=true`, which only
  the local overlay sets.

## Trade-offs and consequences

- **Little in the SBOM:** the SBOM and vulnerability scan cover mostly
  base-image packages. The pipeline is ready for dependencies (`npm ci
  --ignore-scripts`, lockfile, Dependabot, dependency review), but none are
  exercised today.
- **Reinvented pieces:** hand-rolled metrics and a minimal lint step trade
  maturity for supply-chain minimalism. Adopting `prom-client` or ESLint is a
  reasonable change once the service grows, and it is the first time the
  dependency-review gate would matter.
- **No traces:** distributed tracing (OpenTelemetry) is Phase 2 in
  docs/observability.md. The OTel SDK is the dependency most likely to be
  added first.

## Revisit when

- The service needs persistence (a real queue). Add a managed datastore, and
  an ADR for state, backups and migrations.
