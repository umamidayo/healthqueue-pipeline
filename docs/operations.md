# Operations

One-time setup for a real GitHub repository and cluster (no bot or GitHub App required), and recurring
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

## 1. GitHub settings (no bot or GitHub App needed)

Promotions push with the built-in `GITHUB_TOKEN` as `github-actions[bot]`
(ADR 0013). Only repository settings are needed:

1. **Settings > Environments > New environment** named `production`:
   - **Required reviewers:** add yourself or the team. Without reviewers, a
     `promote` run proceeds immediately, so this setting is the production
     gate.
   - **Deployment branches and tags:** `main` only.

   (The first `promote` run creates the environment automatically if it does
   not exist yet, but without reviewers.)
2. **Settings > Actions > General > Workflow permissions:** leave the default
   at **read-only**. The two promotion jobs request `contents: write`
   themselves.
3. **Labels:** create `incident`, `sev1`, `sev2`, `sev3` (used by the
   incident template and the DORA collector).
4. **GHCR:** after the first build on `main`, open the `healthqueue-api`
   package and either set visibility to **public**, or give the cluster an
   image pull secret. Kubernetes cannot pull a private GHCR image anonymously.

To promote:

1. Go to **Actions > promote > Run workflow**.
2. A reviewer approves the pending `production` deployment.
3. The job re-verifies the image, commits the digest, and Argo CD deploys it.

## 2. Protecting `main` (optional)

The settings below back the Source-track claims in [slsa.md](slsa.md).
Without them, everything still works, and the Source track is L1.

`GITHUB_TOKEN` cannot bypass rulesets. A ruleset that requires pull requests
or status checks on `main` therefore blocks the promotion pushes, unless they
come from a **deploy key** that the ruleset allows to bypass. A deploy key is
an SSH key scoped to this repository, not a user or app account.

1. Generate a key: `ssh-keygen -t ed25519 -N "" -C gitops-promotion -f gitops_deploy_key`
2. **Settings > Deploy keys > Add deploy key:** paste `gitops_deploy_key.pub`
   and tick **Allow write access**.
3. **Settings > Secrets and variables > Actions > New repository secret:**
   `GITOPS_DEPLOY_KEY` = contents of `gitops_deploy_key` (the private key),
   then delete both files locally.
4. **Settings > Rules > Rulesets > New branch ruleset** targeting `main`:
   - **Bypass list:** Deploy keys.
   - Require a pull request; 1 approval (2 for Source L4); dismiss stale
     approvals; require review from Code Owners.
   - Require status checks:
     - `Test`
     - `Validate manifests and policies`
     - `Validate OpenTofu`
     - `Build, SBOM, scan, sign`
     - `Dependency review`
     - `analyze (javascript-typescript)`
     - `analyze (actions)`
   - Block force pushes and deletions.

The promotion jobs pick up `GITOPS_DEPLOY_KEY` automatically
(`actions/checkout` `ssh-key:`). With the secret unset, they use
`GITHUB_TOKEN`.

**Settings > Actions:** allow GitHub-owned and verified actions plus the
specific actions in the workflows, and require approval for fork PR workflows.

## 3. Production platform bootstrap

Prerequisites: a conformant cluster, cluster-admin kubeconfig, and an S3
bucket for state (or change the backend).

```bash
cd infra/envs/production
cp backend.hcl.example backend.hcl                    # fill in bucket/key/region
cp production.tfvars.example production.tfvars        # kube context, Argo CD URL
export TF_VAR_state_encryption_passphrase='...'       # from your secret manager; >= 16 chars

tofu init -backend-config=backend.hcl
tofu plan -var-file=production.tfvars -out=platform.tfplan   # plan is encrypted too
tofu apply platform.tfplan
```

Argo CD now syncs `argocd/clusters/production`: platform policies and alert
rules first (sync waves -2/-1), then staging and production. Production
starts with the all-zero placeholder digest. The first push to `main`
promotes to staging; then run the `promote` workflow.

Expose Argo CD and Grafana through your ingress with SSO. Also replace the
initial Argo CD admin password and disable the account
(`configs.cm.admin.enabled: false`) once SSO works.

*Optional, needs a GitHub App:* to have Argo CD record real sync results as
GitHub Deployments, set `github_app_id` / `github_app_installation_id`, store
the app key in `argocd-notifications-secret` (key `github-privateKey`), and
run the DORA workflow with `--deployment-source deployments` (ADR 0013).

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
| Pinned Fulcio roots in `verify-images.yaml` | when Sigstore announces a Fulcio CA rotation, or if the CI admission pre-check fails with `x509: certificate signed by unknown authority` | Replace the `roots` block with the current `fulcio_v1.crt.pem` + `fulcio_intermediate_v1.crt.pem` from https://tuf-repo-cdn.sigstore.dev (see `targets.json` for the hashed file names); run `kyverno test deploy/platform/policies/tests` and `scripts/ci/verify-admission.sh` against a fresh image |
| Kyverno ClusterPolicy deprecation | every Kyverno upgrade | Read release notes; execute the ADR 0007 migration before removal |
| Rehearse rollback in staging | each sprint | [runbooks/rollback.md](runbooks/rollback.md); time it |
| Review SLO targets and error budget policy | quarterly | Change `observability/slo-spec.json` via PR |
| Review the DORA report recommendations | monthly | Pick the top item; track it as normal work |
| Rotate the GitOps deploy key (if used) | yearly | Add a new deploy key, update `GITOPS_DEPLOY_KEY`, delete the old key |
