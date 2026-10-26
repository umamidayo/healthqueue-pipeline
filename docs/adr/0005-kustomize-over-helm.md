# 0005. Kustomize, not Helm, for application manifests

- Status: Accepted
- Date: 2026-10-25

## Context

The application has three environments (local, staging, production) that
differ in namespace, image reference, replica counts, resources and a few env
vars. The manifests are reviewed in promotion PRs, so reviewers must be able to
see what changes.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Kustomize** (base + overlays + components) | Plain YAML, so what you read is what is applied; built into kubectl and Argo CD; overlays make environment differences explicit; a promotion is a two-line diff | Patches get verbose for big variations; no packaging/versioning story |
| Helm chart | Packaging, versioning, templating; standard for third-party software | Templates hide the output; values sprawl; a promotion diff shows values, not manifests |
| Jsonnet / CUE | Powerful, typed | Extra language to learn; small community for this use |

## Decision

- Use **Kustomize** for the application: `deploy/base` plus `deploy/overlays/{local,staging,production}`.
- Prometheus Operator objects (ServiceMonitor, PrometheusRule, dashboard)
  live in a Kustomize **Component**, `deploy/components/monitoring`. A cluster
  without the operator can drop one line instead of forking the base.
- Images are set with Kustomize's `images:` transformer, by **digest** in
  staging and production. `scripts/promote.mjs` edits only that field and
  refuses to edit an unexpected structure.
- **Third-party software stays on Helm** (Argo CD, Kyverno,
  kube-prometheus-stack), installed by OpenTofu. Those charts are maintained
  upstream, and forking them into Kustomize would be worse.

## Trade-offs and consequences

- Every rendered environment is validated in CI with kubeconform (strict mode,
  CRD schemas) and can be reproduced locally with `kubectl kustomize`.
- Kustomize's load restrictor stops overlays from reading files outside their
  directory. This is why the dashboard JSON lives inside the component
  directory.
- If the service needed to be shipped to other teams as a product, a Helm chart
  (or an OCI artifact of the rendered manifests) would be the better
  distribution format.

## Revisit when

- Environment differences outgrow a handful of patches, or the app is
  distributed to third parties.
