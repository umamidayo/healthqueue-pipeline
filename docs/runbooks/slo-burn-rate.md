# Runbook: SLO error budget burn

Covers `HealthQueueAvailabilityBudgetBurnFast|Slow`,
`HealthQueueLatencyBudgetBurnFast|Slow` and `HealthQueueTargetDown`.

**Fast (page):** at the current rate, the month's budget is gone in about 2
days or less. Act now. **Slow (ticket):** on track to exhaust the budget
within the window. Fix within working hours.

## 1. Triage (5 minutes)

1. **Which environment?** Check the `namespace` label on the alert. Staging
   pages are not emergencies, but they do block promotion.
2. **Did something just change?**

   ```bash
   kubectl -n argocd get application healthqueue-production -o jsonpath='{.status.operationState.finishedAt} {.status.sync.revision}{"\n"}'
   ```

   Also check `git log -5 -- deploy/overlays/production` and the "Running
   versions" dashboard panel. Two versions in that panel means a rollout is in
   progress.
3. **What kind of failure?** Look at the dashboard's request-rate-by-status
   and latency panels:
   - 5xx across all routes points to the app or its pods.
   - Latency only, with no errors, points to saturation. Check CPU
     throttling and HPA at max.
   - `TargetDown` means pods are not running or not scrapeable. Run
     `kubectl -n <ns> get pods`, check events, and check Kyverno admission
     denials with
     `kubectl get events -A --field-selector reason=PolicyViolation`.

## 2. Mitigate

| Situation | Action |
|---|---|
| Started after a deploy | **Roll back first, debug second.** [rollback.md](rollback.md) |
| Saturation (HPA at max, CPU throttled) | Raise `maxReplicas` / CPU in the overlay via PR; Argo CD applies it |
| Pods crash-looping | `kubectl -n <ns> logs deploy/healthqueue-api --previous`; roll back if deploy-related |
| Admission is rejecting new pods | Check the PolicyReport / events: unsigned or wrong-identity image means a pipeline problem (do **not** weaken the policy); Rekor/registry outage means existing pods keep running, so wait or fail over |
| No recent change, cause unclear | Escalate. Capture `kubectl describe` and the logs before restarting anything |

Do not `kubectl edit` workloads. Argo CD self-heal reverts it within minutes.
Every mitigation is a Git change.

## 3. After

- If deploy-related, file an **Incident** issue with
  `Deployment: <sha or id>` (feeds DORA change fail rate) and close it when
  service is restored.
- Postmortem if more than 20% of the budget was consumed, or if the budget is
  exhausted (error budget policy, [observability.md](../observability.md)).
- Add a regression test for the root cause before re-promoting the fix.
