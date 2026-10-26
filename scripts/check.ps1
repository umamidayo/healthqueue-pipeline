<#
.SYNOPSIS
  Runs the same offline checks as CI, on Windows, without a cluster:
  unit tests, coverage gate, SLO rule drift, Kustomize renders, OpenTofu
  fmt/validate, and (if scripts\local\install-tools.ps1 was run) kubeconform,
  promtool, kyverno and actionlint.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'local\common.ps1')
Set-Location $RepoRoot
$results = New-Object System.Collections.Generic.List[object]

function Step([string]$Name, [scriptblock]$Body) {
    Write-Step $Name
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        & $Body
        $results.Add([pscustomobject]@{ Check = $Name; Result = 'pass'; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
    } catch {
        Write-Fail $_.Exception.Message
        $results.Add([pscustomobject]@{ Check = $Name; Result = 'FAIL'; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
    }
}

Assert-Command @('node', 'npm', 'kubectl', 'tofu')

Step 'app: lint + tests + coverage gate' {
    Push-Location app
    try {
        Invoke-Native npm @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
        Invoke-Native npm @('run', 'lint')
        Invoke-Native npm @('run', 'test:ci')
    } finally { Pop-Location }
}
Step 'promotion script tests' { Invoke-Native node @('--test', 'scripts/test/*.test.mjs') }
Step 'DORA toolkit tests' { Push-Location dora; try { Invoke-Native npm @('test') } finally { Pop-Location } }
Step 'SLO rules match spec' { Invoke-Native node @('scripts/gen-slo-rules.mjs', '--check') }

$rendered = Join-Path $env:TEMP "healthqueue-rendered-$PID"
New-Item -ItemType Directory -Force $rendered | Out-Null
Step 'kustomize render (all entry points)' {
    $entries = [ordered]@{
        'overlay-local' = 'deploy/overlays/local'; 'overlay-staging' = 'deploy/overlays/staging'
        'overlay-production' = 'deploy/overlays/production'; 'platform-policies' = 'deploy/platform/policies'
        'platform-observability' = 'deploy/platform/observability'; 'argocd-local' = 'argocd/clusters/local'
        'argocd-production' = 'argocd/clusters/production'
    }
    foreach ($k in $entries.Keys) {
        $yaml = & kubectl kustomize $entries[$k]
        if ($LASTEXITCODE -ne 0) { throw "kustomize failed for $($entries[$k])" }
        [IO.File]::WriteAllLines((Join-Path $rendered "$k.yaml"), [string[]]$yaml)
    }
}

Step 'OpenTofu fmt + validate' {
    Invoke-Native tofu @('fmt', '-check', '-recursive', 'infra')
    foreach ($envDir in @('infra/envs/local', 'infra/envs/production')) {
        Invoke-Native tofu @("-chdir=$envDir", 'init', '-backend=false', '-input=false', '-lockfile=readonly')
        Invoke-Native tofu @("-chdir=$envDir", 'validate')
    }
}

$tools = Join-Path $RepoRoot '.tools\bin'
if (Test-Path (Join-Path $tools 'kubeconform.exe')) {
    Step 'kubeconform (strict, with CRD schemas)' {
        $catalog = 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/3eb90d47aba8d61919d4419dd38301536e32a94b/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
        $files = (Get-ChildItem $rendered -Filter *.yaml).FullName
        Invoke-Native (Join-Path $tools 'kubeconform.exe') (@('-strict', '-summary', '-kubernetes-version', '1.34.12', '-schema-location', 'default', '-schema-location', $catalog) + $files)
    }
    Step 'promtool check + unit tests' {
        $rules = Join-Path $rendered 'rules'
        New-Item -ItemType Directory -Force $rules | Out-Null
        foreach ($pair in @(@('deploy/components/monitoring/slo-rules.yaml', 'slo-rules.yaml'), @('deploy/platform/observability/argocd-rules.yaml', 'argocd-rules.yaml'))) {
            $inSpec = $false
            $lines = foreach ($l in Get-Content $pair[0]) {
                if ($inSpec) { $l -replace '^  ', '' } elseif ($l -match '^spec:') { $inSpec = $true }
            }
            [IO.File]::WriteAllLines((Join-Path $rules $pair[1]), [string[]]$lines)
        }
        Copy-Item observability/tests/*.yaml $rules
        Invoke-Native (Join-Path $tools 'promtool.exe') @('check', 'rules', (Join-Path $rules 'slo-rules.yaml'), (Join-Path $rules 'argocd-rules.yaml'))
        Push-Location $rules
        try { Invoke-Native (Join-Path $tools 'promtool.exe') @('test', 'rules', 'slo-alerts.test.yaml', 'argocd-alerts.test.yaml') } finally { Pop-Location }
    }
    Step 'kyverno policy tests' { Invoke-Native (Join-Path $tools 'kyverno.exe') @('test', 'deploy/platform/policies/tests') }
    Step 'actionlint' { Invoke-Native (Join-Path $tools 'actionlint.exe') @('-no-color') }
} else {
    Write-Warn2 'Schema, PromQL, policy and workflow checks skipped: run .\scripts\local\install-tools.ps1 once to enable them.'
}
Remove-Item -Recurse -Force $rendered -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize | Out-String | Write-Host
if ($results | Where-Object Result -eq 'FAIL') { exit 1 }
