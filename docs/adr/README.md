# Architecture Decision Records

Each ADR records one significant decision: the context, the options that were
considered, the trade-offs, and what would make us revisit it. ADRs are
immutable once accepted. To change a decision, write a new ADR that supersedes
the old one and update the old one's status.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-github-actions-hardening.md) | GitHub Actions with SHA-pinned actions and least-privilege tokens | Accepted |
| [0003](0003-gitops-with-argo-cd.md) | Pull-based GitOps delivery with Argo CD | Accepted |
| [0004](0004-opentofu-for-platform-bootstrap.md) | OpenTofu for platform bootstrap only | Accepted |
| [0005](0005-kustomize-over-helm.md) | Kustomize, not Helm, for application manifests | Accepted |
| [0006](0006-sbom-generation.md) | SBOMs with Syft in SPDX and CycloneDX, attached as signed attestations | Accepted |
| [0007](0007-signing-provenance-admission.md) | Keyless signing, SLSA Build L3 provenance, admission-time verification | Accepted |
| [0008](0008-promotion-model.md) | Digest promotion: automatic to staging, PR-gated to production | Accepted |
| [0009](0009-dora-measurement.md) | DORA metrics from pipeline-emitted events over a 90-day window | Accepted |
| [0010](0010-slo-burn-rate-alerting.md) | SLOs with multi-window, multi-burn-rate alerts generated from a spec | Accepted |
| [0011](0011-stateless-zero-dependency-workload.md) | A stateless, zero-dependency reference workload | Accepted |
| [0012](0012-local-development-on-windows.md) | Local development on Windows with minikube and PowerShell | Accepted |

New ADRs start from [template.md](template.md).
