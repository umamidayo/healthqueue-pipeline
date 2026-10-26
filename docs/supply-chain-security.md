# Supply-chain security

Every control in the pipeline that protects what gets built and run, grouped
by where it acts. For the SLSA mapping see [slsa.md](slsa.md). For the
reasoning behind each choice see ADRs 0002, 0006 and 0007.

## Threat model in one paragraph

An attacker wins if they get code they control running in production. The
paths are:

- change the source without review,
- change the build (a compromised action, base image, or package),
- change the artifact after the build (registry or tag manipulation),
- deploy something that never went through the pipeline at all.

The design assumes each layer might fail, so a later layer re-checks it. A
compromised CI step cannot forge provenance. A forged Git change cannot
produce an admissible image. A pushed image without our signatures cannot
start a pod.

## Controls

### Source

| Control | Where |
|---|---|
| PR + review + required checks on `main`; CODEOWNERS on prod/platform/IaC/pipeline paths | GitHub rulesets ([operations.md](operations.md#2-repository-rulesets)), `.github/CODEOWNERS` |
| CodeQL for JS/TS **and GitHub Actions workflows** (script injection, excessive permissions) | `.github/workflows/codeql.yml` |
| OpenSSF Scorecard (branch protection, pinning, token permissions, ...) | `.github/workflows/scorecard.yml` |

### Dependencies

| Control | Where |
|---|---|
| Actions pinned by full commit SHA (one documented exception: the SLSA generator) | all workflows |
| Base images pinned by digest; distroless runtime (no shell, no package manager) | `app/Dockerfile` |
| `npm ci --ignore-scripts` (no install-time code execution); committed lockfiles | `app/Dockerfile`, workflows |
| Zero runtime npm dependencies (minimal attack surface) | ADR 0011 |
| OpenTofu provider lock files with multi-platform hashes; `-lockfile=readonly` in CI | `infra/envs/*/.terraform.lock.hcl` |
| Helm charts pinned to exact versions | `infra/modules/platform/variables.tf` |
| CI tool binaries verified against SHA-256 values committed in the repo | `scripts/ci/install-tools.sh`, `scripts/local/install-tools.ps1` |
| Dependabot for actions, Docker digests, npm, OpenTofu providers (grouped) | `.github/dependabot.yml` |
| Dependency review on PRs: High+ advisories and copyleft licences blocked | `ci.yml` |

### Build

| Control | Where |
|---|---|
| Workflow-level `permissions: {}`; per-job least privilege | all workflows |
| `persist-credentials: false` except where a push is required | all workflows |
| Untrusted inputs passed through `env:`, never interpolated into scripts | `dora.yml`, `ci.yml` |
| Runner egress auditing (harden-runner) | all jobs |
| Ephemeral GitHub-hosted runners | all jobs |
| BuildKit attestations disabled in favour of explicitly signed ones | `ci.yml` build step |

### Artifact

| Control | Where |
|---|---|
| SBOM (SPDX + CycloneDX) from the built image | `ci.yml` build |
| Vulnerability gate (Grype, fixable High/Critical) + code scanning upload | `ci.yml` build |
| Keyless signature bound to `ci.yml@refs/heads/main` | `ci.yml` build |
| Signed CycloneDX SBOM attestation | `ci.yml` build |
| SLSA Build L3 provenance | `ci.yml` provenance |
| Immutable `sha-<commit>` tags only; deployment by digest | `ci.yml`, overlays |

### Deploy and runtime

| Control | Where |
|---|---|
| Pre-promotion verification (signature, SBOM, provenance, source branch, entry point) | `scripts/ci/verify-image.sh` |
| **Admission:** Kyverno verifies the same at pod creation, fail-closed, for staging + production | `deploy/platform/policies/verify-images.yaml` |
| **Admission:** only `ghcr.io/<owner>/*@sha256:*` images in staging + production | `deploy/platform/policies/require-digest.yaml` |
| Pod Security Admission `restricted` on every app namespace | `deploy/base/namespace.yaml` |
| Non-root UID, read-only root fs, all capabilities dropped, seccomp RuntimeDefault, no SA token | `deploy/base/deployment.yaml` |
| Default-deny NetworkPolicy; ingress only on the HTTP port; egress only DNS | `deploy/base/networkpolicy.yaml` |
| Argo CD AppProjects: app cannot create RBAC or cluster-scoped objects (except its Namespace); policies live in a separate project | `argocd/base/projects.yaml` |
| Kyverno webhooks exclude platform namespaces, so a policy bug cannot brick the control plane | `infra/modules/platform/values/kyverno.yaml.tftpl` |
| OpenTofu state + plan encrypted client-side in production | `infra/envs/production/main.tf` |
| GitHub App private key for Argo CD Notifications stored only in a Kubernetes Secret, never in Tofu state | `values/argocd.yaml.tftpl` (`secret.create: false`) |

## Residual risks (accepted, tracked)

| Risk | Why accepted | Mitigation / next step |
|---|---|---|
| Actions that download tools at runtime (Grype DB, Syft) are not content-pinned | No input exposes a checksum | harden-runner egress audit; move to `egress-policy: block` with an allow-list |
| Release bot can push to `main` | Needed for hands-off staging (ADR 0008) | Push ruleset limiting the bot to `deploy/overlays/staging/**` |
| Public Sigstore dependency at admission | Keyless removes key management | Kyverno result caching; private Sigstore if air-gapped |
| Kyverno ClusterPolicy deprecation | Still enforced in 1.19 | Migration plan in ADR 0007; `kyverno test` in CI catches removal |
| Unfixed CVEs pass the gate (`only-fixed`) | Blocking on unfixable CVEs blocks all delivery | Visible in code scanning; distroless + Dependabot digests |
