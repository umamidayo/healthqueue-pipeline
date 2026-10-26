# 0013. Promote with GITHUB_TOKEN and a GitHub Environment gate, without a bot

- Status: Accepted (supersedes the GitHub App and pull-request parts of ADR 0008)
- Date: 2026-10-25

## Context

ADR 0008 relied on a GitHub App (a "release bot") for two things:

- pushing staging digest commits to `main`,
- opening production promotion PRs that trigger CI.

ADR 0009 used the same app so Argo CD Notifications could write GitHub
Deployments for DORA.

In practice the app could not be created for this repository, and the
requirement became: **GitOps to Docker/Kubernetes must run and pass every
check with no bot or app account at all.**

Constraints of the built-in `GITHUB_TOKEN`:

- It can push to `main` if no ruleset blocks it, but it **cannot bypass
  rulesets**.
- Pull requests it opens **do not trigger workflows**, so a required-check
  promotion PR would never go green.
- Commits it pushes do not trigger workflows either. That is harmless here,
  since promotion commits carry `[skip ci]` anyway.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **`GITHUB_TOKEN` pushes + GitHub Environment `production` as the gate** | Zero extra identities or secrets; works out of the box; the environment can require reviewers, restrict branches, and records who approved each run | The production change is a direct commit, not a reviewable PR; a "require PR" ruleset on `main` blocks it (see deploy key below) |
| `GITHUB_TOKEN` opens the PR, then dispatches CI on the branch | Keeps the PR | Fragile: checks only attach via `workflow_dispatch`; needs the "Allow Actions to create PRs" setting; more moving parts |
| Fine-grained personal access token | PRs trigger CI | Tied to one human's account (a bot in all but name); expires; broad blast radius if leaked |
| Argo CD Image Updater | No CI writes | Still needs Git write credentials; promotes by registry policy rather than a verified digest |

## Decision

- **Staging:** `ci.yml / promote-staging` commits the verified digest with
  `GITHUB_TOKEN` as GitHub's built-in `github-actions[bot]` identity, with
  the same ordering guard and rebase retry as before.
- **Production:** `promote.yml` runs in the **`production` GitHub
  Environment**. With required reviewers configured, the run pauses until
  one approves. It then re-verifies the staging digest and commits it to
  `deploy/overlays/production` (`[skip ci]`, `Source-Revision:` trailer,
  link to the run). Argo CD syncs it.
- **Protected `main`:** if `main` gets a ruleset requiring PRs or checks, add
  a repository **deploy key** with write access, list it as the ruleset's
  bypass actor, and store its private key as `GITOPS_DEPLOY_KEY`. The
  promotion checkouts already pass `ssh-key:`. When the secret is empty they
  use `GITHUB_TOKEN`. A deploy key is scoped to one repository and is not a
  user or app account.
- **DORA:** production deploys come from **promotion commits** by default
  (`--deployment-source commits`), with the source revision read from the
  commit trailer. GitHub Deployments are **opt-in only**. The promote job's
  `environment:` creates Deployment records automatically, but they point at
  the commit the run *started* from, so reading them would attribute every
  change to the wrong release.
- **Argo CD Notifications:** the GitHub notifier stays available but off.
  `github_app_id` is now optional everywhere.

## Trade-offs and consequences

- **Gate:** the production gate is an environment approval, not a PR review.
  The approver sees the run summary (image, source revision, compare link,
  verification log), and GitHub records the approval. There is no diff view
  or comment thread. The diff is always two fields of `kustomization.yaml`
  plus `release.json`, so little is lost.
- **Failed syncs:** DORA's deploy timestamps are commit times, not cluster
  convergence (typically 0-3 minutes later), and **failed syncs are not
  counted** in the change fail rate. `ArgoCDSyncFailing` still alerts on
  them. Re-enable the Deployments source with a GitHub App to count them.
- **Source track:** without a protected `main` (no deploy key), the SLSA
  Source-track claims in docs/slsa.md drop to L1. With the deploy key and a
  PR-requiring ruleset, they are unchanged.
- **Who can promote:** anyone who can run workflows can *request* a promotion.
  Only environment reviewers can *approve* it, once reviewers are configured.
  Until then, the gate is open.

## Revisit when

- A GitHub App becomes available. Restoring PR-based promotion and
  Deployments-based DORA is a configuration change plus ADR 0008's workflow
  shape.
