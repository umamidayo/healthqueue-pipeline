# SLSA alignment

How this pipeline maps to [SLSA](https://slsa.dev) (Supply-chain Levels for
Software Artifacts): which requirements are met, by what, and where the gaps
are. Requirement wording follows the SLSA v1.x specification. Re-check it
against the current spec when upgrading, because the Source track is newer
and still settling.

## Summary

| Track | Level claimed | Basis |
|---|---|---|
| **Build** | **L3** | Hosted, ephemeral GitHub runners; provenance generated and signed by the isolated `slsa-github-generator` reusable workflow; verified at admission |
| **Source** | **L2-aligned** when the ruleset and deploy key in [operations.md](operations.md#2-protecting-main-optional) are applied; **L1** without them | Git history on GitHub; rulesets enforcing PRs, reviews and status checks; CODEOWNERS |
| Dependencies | Not a SLSA level; addressed by pinning + SBOM + scanning | See [supply-chain-security.md](supply-chain-security.md) |

"Aligned" means the controls exist and are configured by this repo or its
documented settings. It does not mean an external audit has attested them.

## Build track

| Requirement | Level | How it is met | Evidence |
|---|---|---|---|
| Provenance exists | L1 | Every pushed image gets SLSA provenance (`predicateType: https://slsa.dev/provenance/v0.2`) | `ci.yml` job `provenance` |
| Provenance is complete (builder, source, entry point, parameters) | L1 | Generator records `builder.id`, `invocation.configSource.{uri,digest,entryPoint}`, and GitHub context | `cosign verify-attestation --type slsaprovenance <image>` |
| Hosted build platform | L2 | GitHub-hosted runners (`ubuntu-24.04`); no self-hosted runners | all workflow jobs |
| Provenance is authentic (signed by the build platform) | L2 | Sigstore keyless signature, identity = generator workflow at a release tag, OIDC issuer = GitHub | `verify-image.sh` step 3; Kyverno `attestations[0].attestors` |
| Provenance is unforgeable by tenants (build steps) | L3 | Provenance is generated in a separate job of a trusted reusable workflow. Our build steps never hold its OIDC token or signing identity, and the generator derives facts from GitHub's OIDC claims, not from our job's outputs | `generator_container_slsa3.yml@v2.1.0` |
| Builds are isolated from one another | L3 | Ephemeral VM per job; the Docker layer cache (`type=gha`) is branch-scoped, so `main` cannot read caches written by PR branches | GitHub Actions cache scoping rules |
| Verification by consumers | (expected of consumers) | CI `verify` job, and Kyverno at admission for staging/production. Both check signer identity, `configSource.uri = git+https://github.com/<repo>@refs/heads/main`, and `entryPoint = .github/workflows/ci.yml` | `deploy/platform/policies/verify-images.yaml` |

### Known Build-track caveats

- **Tag-referenced generator.** The SLSA generator is the one action
  referenced by tag rather than SHA, because it verifies its own ref. Trust
  is anchored on the generator's release process. Kyverno and
  `verify-image.sh` accept any `vX.Y.Z` tag of the generator by regex. Pin to
  one exact tag in both if you want upgrades to be an explicit change.
- **v0.2 predicate.** The container generator emits SLSA v0.2. Moving to
  v1.0 provenance (for example via GitHub artifact attestations) is part of
  the ClusterPolicy migration in ADR 0007.
- **Reproducibility (not a SLSA requirement).** Builds use `SOURCE_DATE_EPOCH`
  from the commit, and base images are digest-pinned. Builds are not yet
  verified to be bit-for-bit reproducible.

## Source track

| Control | Level it supports | How it is met |
|---|---|---|
| Version controlled, with immutable history and identity | L1 | Git on GitHub; force-push and deletion blocked on `main` by ruleset |
| Changes reviewed and attributable; protected branch history | L2 | Ruleset: PR required, 1+ approval, CODEOWNERS review for `deploy/overlays/production`, `deploy/platform`, `infra`, `.github`, `argocd` |
| Continuous technical controls (required checks) | L3 | Required status checks: `Test`, `Validate manifests and policies`, `Validate OpenTofu`, `Build, SBOM, scan, sign`, `Dependency review`, CodeQL |
| Two-party review of every change | L4 | Achievable by requiring 2 approvals and dismissing stale approvals. Not enabled by default, because a solo maintainer cannot satisfy it |

Gaps:

- **Automated pushes bypass review.** Staging and production digest commits
  reach `main` without a PR (ADR 0013). They are machine-generated from a
  verified artifact, attributable to `github-actions[bot]`, limited to one
  overlay each, and for production gated by environment approval. With a
  protected `main`, the deploy key is the only bypass actor.
- **Signed commits** are recommended but not required, so the reference
  works for contributors without signing keys.
- **No source provenance attestations** (VSAs for the source revision) are
  produced.

## SLSA threats and the controls that address them

| SLSA threat | Example | Control in this repo |
|---|---|---|
| (A) Submit unauthorized change | Push straight to main | Ruleset: PR + review + required checks; CODEOWNERS |
| (B) Compromise source repo | Rewrite history | Ruleset: block force-push and deletion; Scorecard monitors settings |
| (C) Build from modified source | Build a fork, or a branch, and deploy it | Provenance `configSource.uri` must be `refs/heads/main` of this repo (Kyverno + `verify-image.sh`) |
| (D) Use compromised build dependency | Malicious action, base image | Actions SHA-pinned; base images digest-pinned; CI tools checksum-verified; `npm ci --ignore-scripts`; harden-runner egress audit |
| (E) Compromise build process | Tamper with provenance from a build step | Provenance generated in an isolated reusable workflow (L3) |
| (F) Upload modified package | Push a different image to the same tag | Deployment by digest only (`require-digest.yaml`); signature over the digest |
| (G) Compromise registry | Swap image content | Digest pinning + signature verification at admission |
| (H) Use compromised package | Run an unsigned or foreign image | Kyverno verify + trusted-registry policies, enforced in staging and production |
| Dependency vulnerabilities | Known CVE in base image | Grype gate on SBOM (fixable High/Critical); Dependabot for digests |

## How to verify an image yourself

```bash
IMAGE=ghcr.io/umamidayo/healthqueue-api@sha256:<digest>
scripts/ci/verify-image.sh "$IMAGE" umamidayo/healthqueue-pipeline

# Or inspect the provenance:
cosign verify-attestation --new-bundle-format=false --type slsaprovenance \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/slsa-framework/slsa-github-generator/' \
  "$IMAGE" | jq -r '.payload' | base64 -d | jq '.predicate.invocation.configSource'
```
