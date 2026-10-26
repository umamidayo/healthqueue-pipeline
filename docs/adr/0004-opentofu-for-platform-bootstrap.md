# 0004. OpenTofu for platform bootstrap only

- Status: Accepted
- Date: 2026-10-25

## Context

Before Argo CD can manage anything, something must install Argo CD itself and
the controllers whose CRDs the application uses (Prometheus Operator, Kyverno).
The same bootstrap must work on a laptop (minikube) and on a real cluster. The
project needs OpenTofu for infrastructure.

There is also an overlap risk: if both IaC and GitOps manage the same objects,
they fight.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **OpenTofu** | Open source (MPL-2.0, Linux Foundation); drop-in HCL compatibility; **client-side state and plan encryption** built in; provider lock files with hashes | Smaller ecosystem than Terraform for new features; Dependabot's `terraform` ecosystem is used for updates |
| Terraform | Largest ecosystem; HCP integration | BUSL licence; state encryption needs a backend feature or a paid product |
| Argo CD bootstraps itself (`kubectl apply` of the install manifest, then self-management) | No extra tool | Imperative first step; no plan/diff; nowhere to put cluster-specific inputs |
| Helmfile / scripts | Simple | No state, no drift detection, no plan |

Scope options:

| Scope | Pros | Cons |
|---|---|---|
| Tofu provisions the cluster too (EKS/GKE/AKS) | One tool end to end | Ties the reference to one cloud; cannot run locally |
| **Tofu bootstraps an existing cluster; Argo CD owns everything after** | Cloud-agnostic; identical locally and in production; clean ownership line | Cluster creation is someone else's module |
| Tofu also deploys the app | Single plan | Two reconcilers for the same objects; loses GitOps audit trail |

## Decision

- Use **OpenTofu** with one reusable module, `infra/modules/platform`, and one
  root module per environment (`infra/envs/local`, `infra/envs/production`).
- **Ownership line:** OpenTofu installs Kyverno, kube-prometheus-stack and
  Argo CD, then creates exactly one root Application (via the `argocd-apps`
  chart). Everything else (policies, alert rules, the app) belongs to Argo CD.
- The root Application is created with the `argocd-apps` Helm chart, not a
  `kubernetes_manifest` resource. `kubernetes_manifest` needs the Application
  CRD to exist at **plan** time, so a first `tofu apply` on an empty cluster
  would fail.
- **Production state is encrypted client-side** (`encryption` block,
  `enforced = true`, for state and plan). State holds the generated Grafana
  password and every rendered Helm value. With encryption, bucket access alone
  does not reveal it. The reference uses a `pbkdf2` passphrase key provider
  for portability. A KMS key provider is the production recommendation.
- Local state is plain and on disk. The cluster is disposable, and
  `down.ps1` deletes both.
- Provider versions are locked in committed `.terraform.lock.hcl` files with
  hashes for linux, windows and darwin. CI runs `init -lockfile=readonly`.
- Cluster provisioning is out of scope. Any conformant cluster (EKS, GKE, AKS,
  k3s) works.

## Trade-offs and consequences

- Helm chart versions are pinned in `variables.tf`, but Dependabot does not
  update them. The routine in docs/operations.md covers this. It is the main
  manual upkeep task in the platform.
- Using Helm through Tofu means `tofu plan` shows value changes, not rendered
  manifest diffs. Chart upgrades should be reviewed with `helm template` diffs.
- Losing the encryption passphrase makes the state unreadable. Store it in the
  same secret manager as other break-glass credentials.

## Revisit when

- Tofu begins to manage more than bootstrap (for example DNS, registries or
  cloud IAM). Split those into separate root modules with their own state.
- A KMS is available. Then switch the key provider and migrate state with a
  `fallback` block.
