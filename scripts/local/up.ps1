<#
.SYNOPSIS
  Creates a local Kubernetes environment on Windows that mirrors production:
  minikube + Kyverno + kube-prometheus-stack + Argo CD (installed by OpenTofu),
  with the HealthQueue API deployed by Argo CD (GitOps) or kubectl (Direct).

.DESCRIPTION
  -Mode Argo   (default) Argo CD syncs deploy/overlays/local from your Git
               remote at the current branch. Exercises the real GitOps path,
               but only sees changes you have pushed.
  -Mode Direct Applies deploy/overlays/local from your working tree with
               kubectl. Fast inner loop for unpushed changes; Argo CD is
               installed but given no applications.

  The image is always built inside minikube from ./app, so no registry,
  signing or Docker Hub pulls of the app image are involved locally.

.EXAMPLE
  .\scripts\local\up.ps1
.EXAMPLE
  .\scripts\local\up.ps1 -Mode Direct -Driver hyperv
#>
[CmdletBinding()]
param(
    [ValidateSet('Argo', 'Direct')][string]$Mode = 'Argo',
    [string]$ClusterName = 'healthqueue',
    [ValidateSet('docker', 'hyperv')][string]$Driver = 'docker',
    [ValidateRange(2, 16)][int]$Cpus = 4,
    [ValidateRange(6144, 65536)][int]$MemoryMb = 8192,
    [string]$RepoUrl,
    [string]$Revision
)

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $RepoRoot

Write-Step 'Checking prerequisites'
Assert-Command @('minikube', 'kubectl', 'tofu', 'git')
if ($Driver -eq 'docker') {
    $null = Invoke-Quiet docker @('info', '--format', '{{.ServerVersion}}')
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker is not running. Start Docker Desktop, or use -Driver hyperv (run PowerShell as Administrator).'
    }
}
Write-Ok "tools present, driver=$Driver"

if ($Mode -eq 'Argo') {
    if (-not $RepoUrl) {
        $RepoUrl = Invoke-Quiet git @('remote', 'get-url', 'origin')
        if (-not $RepoUrl) { throw 'No git remote "origin". Push the repo to GitHub and retry, pass -RepoUrl, or use -Mode Direct.' }
        # Argo CD here uses anonymous HTTPS; convert SSH remotes.
        if ($RepoUrl -match '^git@([^:]+):(.+)$') { $RepoUrl = "https://$($Matches[1])/$($Matches[2])" }
    }
    if (-not $Revision) { $Revision = (& git rev-parse --abbrev-ref HEAD).Trim() }
    $dirty = & git status --porcelain
    $ahead = Invoke-Quiet git @('rev-list', '--count', '@{u}..HEAD')
    if ($dirty -or ($ahead -and [int]$ahead -gt 0)) {
        Write-Warn2 "You have uncommitted or unpushed changes. Argo CD deploys '$Revision' from $RepoUrl as pushed, not your working tree. Use -Mode Direct to test local edits."
    }
    Write-Ok "Argo CD will sync $RepoUrl @ $Revision"
}

Write-Step "Starting minikube profile '$ClusterName'"
$status = Invoke-Quiet minikube @('status', '-p', $ClusterName, '--format', '{{.Host}}')
if ($status -eq 'Running') {
    Write-Ok 'already running'
} else {
    Invoke-Native minikube @('start', '-p', $ClusterName, "--driver=$Driver", "--cpus=$Cpus", "--memory=$MemoryMb", '--addons=metrics-server')
}
Invoke-Native kubectl @('config', 'use-context', $ClusterName)

Write-Step 'Building the API image inside minikube'
$sha = (& git rev-parse HEAD).Trim()
Invoke-Native minikube @('-p', $ClusterName, 'image', 'build', '-t', 'healthqueue-api:local',
    '--build-opt=build-arg=BUILD_VERSION=local', "--build-opt=build-arg=BUILD_REVISION=$sha", 'app')
Write-Ok "healthqueue-api:local ($($sha.Substring(0, 12)))"

Write-Step 'Bootstrapping the platform with OpenTofu (Kyverno, Prometheus stack, Argo CD)'
$tfArgs = @(
    '-chdir=infra/envs/local', 'apply', '-auto-approve', '-input=false',
    "-var=kube_context=$ClusterName",
    "-var=create_root_app=$(if ($Mode -eq 'Argo') { 'true' } else { 'false' })"
)
if ($Mode -eq 'Argo') { $tfArgs += @("-var=git_repo_url=$RepoUrl", "-var=git_revision=$Revision") }
Invoke-Native tofu @('-chdir=infra/envs/local', 'init', '-input=false', '-lockfile=readonly')
Invoke-Native tofu $tfArgs

if ($Mode -eq 'Direct') {
    Write-Step 'Applying manifests from the working tree'
    foreach ($path in @('deploy/platform/policies', 'deploy/platform/observability', 'deploy/overlays/local')) {
        Invoke-Native kubectl @('--context', $ClusterName, 'apply', '--server-side', '-k', $path)
    }
} else {
    Write-Step 'Waiting for Argo CD to create the application namespace'
    $deadline = (Get-Date).AddMinutes(5)
    while (-not (& kubectl --context $ClusterName get namespace healthqueue-local --ignore-not-found -o name)) {
        if ((Get-Date) -gt $deadline) {
            throw 'Argo CD did not sync within 5 minutes. Check: kubectl -n argocd get applications'
        }
        Start-Sleep -Seconds 5
    }
}

Write-Step 'Waiting for the API rollout'
$deadline = (Get-Date).AddMinutes(3)
while (-not (& kubectl --context $ClusterName -n healthqueue-local get deployment healthqueue-api --ignore-not-found -o name)) {
    if ((Get-Date) -gt $deadline) { throw 'Deployment healthqueue-api was never created.' }
    Start-Sleep -Seconds 3
}
Invoke-Native kubectl @('--context', $ClusterName, '-n', 'healthqueue-local', 'rollout', 'status', 'deployment/healthqueue-api', '--timeout=300s')

$argoPassword = Get-SecretValue $ClusterName 'argocd' 'argocd-initial-admin-secret' 'password'
$grafanaPassword = (& tofu -chdir=infra/envs/local output -raw grafana_admin_password)

Write-Step 'Ready'
Write-Host @"
  Verify everything:   .\scripts\local\verify.ps1
  Generate traffic:    .\scripts\local\load.ps1 -ErrorPercent 20   (fires the burn-rate alerts)

  API         kubectl -n healthqueue-local port-forward svc/healthqueue-api 18080:80     -> http://localhost:18080/version
  Argo CD     kubectl -n argocd port-forward svc/argocd-server 8080:80                    -> http://localhost:8080  admin / $argoPassword
  Grafana     kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80 -> http://localhost:3000  admin / $grafanaPassword
  Prometheus  kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
  Alerts      kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093:9093

  Rebuild after code changes:  .\scripts\local\up.ps1 -Mode $Mode   (idempotent)
  Tear down:                   .\scripts\local\down.ps1
"@
