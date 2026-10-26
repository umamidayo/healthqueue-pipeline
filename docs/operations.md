# Operations

One-time setup for a real GitHub repository and cluster, and recurring
maintenance. The local environment needs none of this
([local-development.md](local-development.md)).

## 0. Make it yours

The repository owner `umamidayo` appears in:

- image names (`ghcr.io/umamidayo/healthqueue-api`),
- Kyverno identities,
- Argo CD repo URLs,
- CODEOWNERS and runbook links.

Replace it everywhere:

```powershell
Get-ChildItem -Recurse -File -Exclude *.lock.hcl | Where-Object { $_.FullName -notmatch '\\(\.git|node_modules|\.tools)\\' } |
  ForEach-Object { (Get-Content $_.FullName -Raw) -replace 'umamidayo', 'your-org' | Set-Content -NoNewline -Encoding utf8 $_.FullName }
node scripts/gen-slo-rules.mjs   # regenerate (runbook URL lives in the spec)
```

## 1. Release bot (GitHub App)

One app serves two purposes. CI uses it to push staging promotions and open
production PRs. Argo CD Notifications uses it to write GitHub Deployments.

1. Create a GitHub App (Settings > Developer settings > GitHub Apps). No
   webhook. Repository permissions:

   | Permission | Access | Used by |
   |---|---|---|
   | Contents | Read & write | staging promotion push, PR branch |
   | Pull requests | Read & write | production promotion PR |
   | Deployments | Read & write | Argo CD Notifications |
   | Commit statuses | Read & write | Argo CD Notifications |
   | Metadata | Read | required |

2. Install it on the repository, then generate a private key.
3. Repository **variable** `RELEASE_BOT_CLIENT_ID` = the app's Client ID.
4. Repository **secret** `RELEASE_BOT_PRIVATE_KEY` = the PEM contents.
5. Create the label `promotion` (used on production PRs) and `incident`,
   `sev1`, `sev2`, `sev3` (used by the incident template and the DORA
   collector).

## 2. Repository rulesets

These settings back the Source-track claims in [slsa.md](slsa.md).

**Branch ruleset on `main`:**

- Require a pull request; 1 approval (2 for Source L4); dismiss stale
  approvals; require review from Code Owners.
- Require these status checks to pass:
  - `Test`
  - `Validate manifests and policies`
  - `Validate OpenTofu`
  - `Build, SBOM, scan, sign`
  - `Dependency review`
  - `analyze (javascript-typescript)`
  - `analyze (actions)`
- Block force pushes and deletions.
- Bypass list: the release bot app only.

**Push ruleset (recommended):** restrict the release bot to
`deploy/overlays/staging/**` and `deploy/overlays/production/**`, so the
bypass cannot be used to change code. Exact UI support for actor-scoped push
rules depends on your GitHub plan. Where unavailable, CODEOWNERS plus
Scorecard monitoring is the fallback.

**Settings > Actions:**

- Workflow permissions: **read-only** `GITHUB_TOKEN` default.
- Allow actions: GitHub-owned, verified creators, and the specific actions
  used in the workflows.
- Require approval for fork PR workflows.

**GHCR:**

- After the first push, set package `healthqueue-api` visibility to public,
  or give the cluster an image pull secret.
- Link the package to the repository so `GITHUB_TOKEN` can push.

## 3. Production platform bootstrap

Prerequisites: a conformant cluster, cluster-admin kubeconfig, and an S3
bucket for state (or change the backend).

```bash
cd infra/envs/production
cp backend.hcl.example backend.hcl                    # fill in bucket/key/region
cp production.tfvars.example production.tfvars        # context, Argo CD URL, app IDs
export TF_VAR_state_encryption_passphrase='...'       # from your secret manager; >= 16 chars

tofu init -backend-config=backend.hcl
tofu plan -var-file=production.tfvars -out=platform.tfplan   # plan is encrypted too
tofu apply platform.tfplan
```

Then give Argo CD Notifications the app key. This happens out-of-band, so it
never enters Tofu state:

```bash
kubectl -n argocd create secret generic argocd-notifications-secret \
  --from-file=github-privateKey=release-bot.private-key.pem
```

Argo CD now syncs `argocd/clusters/production`: platform policies and alert
rules first (sync waves -2/-1), then staging and production. Production
starts with the all-zero placeholder digest. The first merge to `main`
promotes to staging, then run the `promote` workflow.

Expose Argo CD and Grafana through your ingress with SSO. Also replace the
initial Argo CD admin password and disable the account
(`configs.cm.admin.enabled: false`) once SSO works.

## 4. Alert routing

Edit `alertmanager.config` in
`infra/modules/platform/values/kube-prometheus-stack.yaml.tftpl`. Add
receivers for `page` and `ticket` (see
[observability.md](observability.md#alerting)), then re-apply Tofu.

## Recurring maintenance

| Task | Cadence | How |
|---|---|---|
| Review and merge Dependabot PRs (actions, digests, npm, providers) | weekly | Auto-merge patch/minor once the DORA report shows the toil (see dora.md) |
| **Helm chart upgrades** (Argo CD, Kyverno, kube-prometheus-stack) | monthly | Not covered by Dependabot. Check release notes; bump `chart_versions` in `infra/modules/platform/variables.tf`; `helm template` old vs new and diff; apply to local first (`up.ps1`), then production |
| CI tool versions (`install-tools.sh` / `.ps1`) | quarterly | Bump version + SHA-256 in **both** scripts from the upstream checksum file |
| Kyverno ClusterPolicy deprecation | every Kyverno upgrade | Read release notes; execute the ADR 0007 migration before removal |
| Rehearse rollback in staging | each sprint | [runbooks/rollback.md](runbooks/rollback.md); time it |
| Review SLO targets and error budget policy | quarterly | Change `observability/slo-spec.json` via PR |
| Review the DORA report recommendations | monthly | Pick the top item; track it as normal work |
| Rotate the release bot private key | yearly | Generate a new key, update the secret and `argocd-notifications-secret`, revoke the old key |
