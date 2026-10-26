# 0002. GitHub Actions with SHA-pinned actions and least-privilege tokens

- Status: Accepted
- Date: 2026-10-25

## Context

The pipeline needs a CI system that can build containers, issue OIDC
identities for keyless signing, and produce SLSA provenance. The source
already lives on GitHub.

CI is also the most privileged part of the supply chain: it holds registry
credentials and signing identity. Third-party actions run with the job's
token. Mutable tags are a proven attack path. In March 2025 the
`tj-actions/changed-files` tags were repointed to a commit that dumped CI
secrets from thousands of repositories.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **GitHub Actions** | Native to the repo; OIDC tokens built in; `slsa-github-generator` gives SLSA Build L3 provenance; free hosted runners for public repos; huge action ecosystem | Ecosystem quality varies; YAML expressions are easy to get wrong (script injection); vendor lock-in to GitHub |
| GitLab CI | Strong built-in security scanning; single vendor for SCM + CI | Source is on GitHub; would need mirroring; no equivalent of the SLSA generator |
| Tekton / Argo Workflows (in-cluster) | Kubernetes-native; Tekton Chains does SLSA provenance | Must operate and secure the CI cluster; slower feedback; much more to build |
| Jenkins | Flexible; self-hosted | Plugin supply-chain risk; long-lived agents; ops burden; no native OIDC |

## Decision

Use GitHub Actions, hardened as follows:

1. **Pin every action to a full commit SHA**, with the version in a trailing
   comment. Dependabot updates both. The only exception is
   `slsa-framework/slsa-github-generator`, which must be called by tag so that
   it can verify its own identity (see ADR 0007).
2. **`permissions: {}` at workflow level.** Each job requests only the scopes
   it needs (for example, `id-token: write` only where signing happens).
3. **`persist-credentials: false`** on checkout unless the job has to push.
4. **No `${{ }}` interpolation of untrusted input inside `run:`.** Values go
   through `env:` (for example, the DORA window input).
5. **`step-security/harden-runner` in audit mode** on every job. It records
   egress, so an unexpected outbound connection shows up in the run insights.
   Switching to `egress-policy: block` with an allow-list is a follow-up once
   the baseline is known.
6. **Static checks of the workflows themselves:** actionlint in CI, CodeQL's
   `actions` language, and OpenSSF Scorecard.
7. **CLI tools downloaded in CI are checksum-verified** against hashes stored
   in the repo (`scripts/ci/install-tools.sh`).
8. **Pushes to `main` use a GitHub App token**, not `GITHUB_TOKEN` (ADR 0008).

## Trade-offs and consequences

- SHA pins are unreadable without the comment and create Dependabot PRs. The
  DORA toil report tracks that cost (`dependency-pr-toil`) and recommends
  grouped updates plus auto-merge for patch bumps.
- Pinning an action does not pin what it downloads at runtime. Several actions
  fetch a tool themselves (for example, `anchore/scan-action` downloads
  Grype). The tool version is recorded where an input allows it (cosign). The
  rest is accepted residual risk, made visible by harden-runner's egress log.
- Hosted runners are ephemeral and isolated, which SLSA Build L3 requires. The
  trade-off is no persistent caches beyond the `type=gha` Docker layer cache.
- This design is locked into GitHub. The scripts under `scripts/` are plain
  bash/Node, so the logic would move to another CI. The OIDC-based signing
  identity and the SLSA generator would not.

## Revisit when

- Builds need hardware or network access that hosted runners cannot provide.
  Self-hosted runners would then need their own L3 isolation story.
- GitHub's native artifact attestations reach parity with the SLSA generator
  for verification by Kyverno (see ADR 0007).
