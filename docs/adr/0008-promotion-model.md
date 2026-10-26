# 0008. Digest promotion: automatic to staging, PR-gated to production

- Status: Accepted
- Date: 2026-10-25

## Context

A verified image has to move from "built" to "running in staging" to "running
in production". Requirements:

- The artifact that ran in staging is byte-for-byte the one that reaches
  production. There is no rebuild per environment.
- Staging should track main without human effort (DORA: lead time).
- Production needs a deliberate human decision for now. The team has to
  trust the pipeline before it can remove that gate.
- Each step is an auditable Git change that can be reverted.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **CI writes the digest into the overlay (Git write-back)** | Promotion is a normal commit/PR: reviewable, revertible, attributed; works with any GitOps tool | CI needs push rights to main; bot commits in history |
| Argo CD Image Updater | No CI write access; watches the registry | Promotes by tag/semver policy rather than an explicit verified digest; harder to tie to provenance; separate component |
| Mutable tags per environment (`:staging`, `:prod`) | Trivial | Not reproducible; defeats digest-based admission; rollback is unclear |
| Separate config repository | Clean history; no CI loop risk | Two repos to coordinate; lead-time measurement must join across repos |

## Decision

- **Pin by digest everywhere outside local.** `scripts/promote.mjs` updates
  `kustomization.yaml` and writes `release.json`, which records the
  **source revision** the digest was built from. That record is what lets
  DORA lead time be exact (ADR 0009).
- **Staging is automatic.** After `verify` passes on main, `promote-staging`
  commits the digest to `deploy/overlays/staging` with message
  `chore(deploy): promote <sha> to staging [skip ci]` and a
  `Source-Revision:` trailer.
  - **Ordering guard:** two main builds can finish out of order, so the job
    only promotes if the new commit descends from what staging already runs.
    Staging never moves backwards.
- **Production is a PR.** The `promote` workflow re-verifies the staging
  digest, copies its `release.json` to production, and opens a PR with the
  image, a compare link, and the verification log. CODEOWNERS approval plus
  merge is the gate. Argo CD deploys on merge.
- **Pushes use a GitHub App token.** That token can bypass the main ruleset,
  and unlike `GITHUB_TOKEN` its PRs trigger CI, so the promotion PR runs the
  required checks.
- **Mono-repo:** app, manifests and platform config share one repo, so one
  commit range describes a release.

## Trade-offs and consequences

- The release bot can push to main. Mitigation: it only acts in one job, after
  verification. Its commits carry `[skip ci]`, are attributable, and touch
  only `deploy/overlays/staging`. A push ruleset restricting the bot to that
  path is a recommended hardening (docs/operations.md).
- Bot commits add noise to `git log`. Use `git log --invert-grep --grep='chore(deploy)'`.
- The PR gate costs time. The DORA report measures the staging-to-production
  wait and recommends the next step when it exceeds 24h: scheduled promotion,
  then SLO-gated auto-merge with Argo Rollouts analysis.
- Rollback = revert the promotion commit. Argo CD restores the previous digest,
  which is still signed and still passes admission.

## Revisit when

- The change fail rate stays under 5% for a quarter with the PR gate. That is
  the evidence for automating production promotion.
- The repo becomes multi-service. A separate environment-config repo then
  scales better.
