# Runbook: roll back a deployment

Also covers `ArgoCDAppDegraded`, `ArgoCDAppOutOfSync` and `ArgoCDSyncFailing`.

A rollback is a Git revert. The previous digest is still signed, still has
its SBOM and provenance, and still passes admission, so it can always be
redeployed.

## Production

1. Find the promotion that introduced the problem:

   ```bash
   git log --oneline -5 -- deploy/overlays/production
   ```

2. Revert it and push to `main` (or open a PR if `main` requires one):

   ```bash
   git switch main && git pull
   git revert --no-edit <promotion-commit-sha>
   git push
   ```

   Do not re-run `promote` to roll back. It always promotes what staging
   runs, and staging may contain the bad build.
3. Watch Argo CD converge (usually under 3 minutes; trigger a refresh to skip
   polling):

   ```bash
   kubectl -n argocd get application healthqueue-production -w
   kubectl -n healthqueue-production rollout status deploy/healthqueue-api
   ```

4. Confirm the burn-rate panel is falling and `/version` reports the previous
   revision.

## Staging

Revert the `chore(deploy): promote ... to staging` commit on `main`. The next
merge to `main` promotes again, so fix forward or revert the offending app
commit too.

## Sync failures and drift

| Alert | Likely cause | Action |
|---|---|---|
| `ArgoCDSyncFailing` | Invalid manifest that passed CI (rare), or admission rejection | `kubectl -n argocd get app <name> -o yaml` and look at `status.operationState.message`. Admission rejection means the image is not verifiable: check the `ci / verify` job of that commit |
| `ArgoCDAppOutOfSync` for 30m | Auto-sync disabled by someone, sync retries exhausted, or a resource Argo CD cannot manage | Re-enable auto-sync in Git (not in the UI); check `status.conditions` |
| `ArgoCDAppDegraded` | Pods not becoming ready after a sync | Treat as a failed deployment: roll back as above, then investigate |

## After

- Record an **Incident** issue (template) with the `Deployment:` line, and
  close it when service is restored.
- Rehearse this runbook in staging each sprint and record the time. The DORA
  report's recovery-time metric reflects how well it works.
