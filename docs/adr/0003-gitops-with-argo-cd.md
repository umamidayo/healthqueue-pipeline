# 0003. Pull-based GitOps delivery with Argo CD

- Status: Accepted
- Date: 2026-10-25

## Context

Deployments must be auditable (who changed what, and when), easy to roll back,
and must not require CI to hold cluster-admin credentials. The cluster should
converge on a declared state and correct manual drift. The project needs an
Argo CD-based deployment path.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Argo CD (pull)** | Cluster pulls from Git, so CI holds no cluster credentials; drift detection and self-heal; UI shows sync and health; app-of-apps; notifications can emit deployment events | Another control plane to run and secure; reconciliation delay (polling); learning curve for sync waves and hooks |
| Flux CD (pull) | Lighter weight; strong Kustomize/Helm controllers; native OCI sources | No built-in UI; notifications less suited to writing GitHub Deployments |
| Push from CI (`kubectl apply` / `helm upgrade`) | Simplest; immediate | CI needs long-lived cluster credentials; no drift correction; rollback is "re-run an old job" |

## Decision

Argo CD, installed by OpenTofu (ADR 0004), with an **app-of-apps** layout:

- `argocd/clusters/<cluster>/` is the root for one cluster. It includes
  `argocd/base` (AppProjects plus platform apps) and that cluster's
  environment Applications.
- Two **AppProjects** separate concerns. `healthqueue` may only deploy to
  `healthqueue-*` namespaces, cannot create RBAC, and has no cluster-scoped
  objects except its Namespace. `platform` owns Kyverno ClusterPolicies and
  platform alert rules. Application owners cannot weaken admission policy.
- All Applications use **automated sync with prune and self-heal**. Git is the
  only way to change the cluster, and manual edits are reverted.
- **Production also auto-syncs.** The human gate is the approved `promote`
  run in the `production` environment (ADR 0013), not a Sync button. A
  promotion commit is a deployed change, which keeps DORA deployment
  timestamps honest.
- The reference topology runs **staging and production as namespaces on one
  cluster** (`argocd/clusters/production`). This keeps the example runnable
  with one cluster. A real deployment should use a cluster per environment:
  add `argocd/clusters/staging` and point each root at its own directory.

## Trade-offs and consequences

- Pull-based delivery adds latency (up to `timeout.reconciliation`, 180s). A
  GitHub webhook to Argo CD removes most of it. The DORA toil report flags a
  slow merge-to-staging time if it matters.
- Self-heal makes emergency `kubectl edit` ineffective by design. The
  emergency path is a Git revert (docs/runbooks/rollback.md), which is also
  the audit trail.
- Namespaces as environments share a blast radius: a cluster-level failure
  takes out staging and production together. This is accepted for the
  reference, but not for real production.
- Argo CD is now part of the production path and needs its own monitoring.
  The `deploy/platform/observability` alerts cover degraded, out-of-sync and
  failing apps.

## Revisit when

- Multi-cluster fleets need generated Applications: switch the cluster roots
  to an ApplicationSet with a cluster generator.
- Progressive delivery is adopted. Argo Rollouts integrates with this layout
  without changing the GitOps model.
