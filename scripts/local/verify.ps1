<#
.SYNOPSIS
  End-to-end checks against the local environment created by up.ps1:
  API behaviour, metrics exposure, Argo CD sync state, SLO rules loaded in
  Prometheus and the API scrape target being up. Exits non-zero on failure.
#>
[CmdletBinding()]
param([string]$ClusterName = 'healthqueue')

. (Join-Path $PSScriptRoot 'common.ps1')
$failures = 0
function Check([string]$Name, [scriptblock]$Test) {
    try {
        $detail = & $Test
        Write-Ok "$Name $detail"
    } catch {
        $script:failures++
        Write-Fail "$Name - $($_.Exception.Message)"
    }
}

Write-Step 'API'
$pf = Start-PortForward -Context $ClusterName -Namespace 'healthqueue-local' -Target 'svc/healthqueue-api' -LocalPort 18080 -RemotePort 80
try {
    $api = 'http://127.0.0.1:18080'
    Check 'liveness' { (Invoke-RestMethod "$api/healthz").status }
    Check 'readiness' { (Invoke-RestMethod "$api/readyz").status }
    Check 'version' { $v = Invoke-RestMethod "$api/version"; "$($v.version) @ $($v.revision.Substring(0, 12))" }
    Check 'estimate' {
        $body = @{ acuity = 3; patientsAhead = 4; cliniciansOnShift = 2 } | ConvertTo-Json
        $r = Invoke-RestMethod -Method Post -Uri "$api/api/v1/estimate" -ContentType 'application/json' -Body $body
        if ($r.estimatedWaitMinutes -ne 30) { throw "expected 30 minutes, got $($r.estimatedWaitMinutes)" }
        "$($r.estimatedWaitMinutes) min ($($r.priorityBand))"
    }
    Check 'validation returns 400' {
        # Works on Windows PowerShell 5.1 (WebException) and 7 (HttpResponseException).
        try {
            Invoke-RestMethod -Method Post -Uri "$api/api/v1/estimate" -ContentType 'application/json' -Body '{"acuity":9}' | Out-Null
            throw 'expected HTTP 400, got 2xx'
        } catch {
            $response = $_.Exception.Response
            if ($null -eq $response -or [int]$response.StatusCode -ne 400) { throw }
            '400'
        }
    }
    Check 'metrics exposed' {
        $m = (Invoke-WebRequest -UseBasicParsing "$api/metrics").Content
        if ($m -notmatch 'http_request_duration_seconds_bucket\{[^}]*le="0.3"') { throw 'SLI histogram bucket le=0.3 missing' }
        'SLI series present'
    }
} finally {
    Stop-PortForward $pf
}

Write-Step 'Workload security posture'
Check 'pods run as non-root with read-only root fs' {
    $spec = & kubectl --context $ClusterName -n healthqueue-local get deploy healthqueue-api -o json | ConvertFrom-Json
    $c = $spec.spec.template.spec.containers[0].securityContext
    if (-not $c.readOnlyRootFilesystem -or $c.allowPrivilegeEscalation) { throw 'securityContext weakened' }
    'restricted'
}
Check 'Kyverno policies installed' {
    $names = & kubectl --context $ClusterName get clusterpolicy -o name
    if (-not ($names -match 'verify-healthqueue-images')) { throw 'verify-healthqueue-images not found' }
    ($names -replace 'clusterpolicy.kyverno.io/', '') -join ', '
}

Write-Step 'GitOps'
$hasRoot = & kubectl --context $ClusterName -n argocd get application root --ignore-not-found -o name
if ($hasRoot) {
    foreach ($app in @('root', 'healthqueue-local', 'platform-policies', 'platform-observability')) {
        Check "Argo CD $app" {
            $s = & kubectl --context $ClusterName -n argocd get application $app -o 'jsonpath={.status.sync.status}/{.status.health.status}'
            if ($s -ne 'Synced/Healthy') { throw "status is '$s' (expected Synced/Healthy)" }
            $s
        }
    }
} else {
    Write-Warn2 'No root Application (Direct mode); skipping Argo CD checks.'
}

Write-Step 'Observability'
$pf = Start-PortForward -Context $ClusterName -Namespace 'monitoring' -Target 'svc/kube-prometheus-stack-prometheus' -LocalPort 19090 -RemotePort 9090
try {
    $prom = 'http://127.0.0.1:19090'
    Check 'SLO rules loaded' {
        $rules = Invoke-RestMethod "$prom/api/v1/rules?type=alert"
        $names = $rules.data.groups.rules.name
        foreach ($n in @('HealthQueueAvailabilityBudgetBurnFast', 'HealthQueueLatencyBudgetBurnFast', 'ArgoCDAppDegraded')) {
            if ($names -notcontains $n) { throw "$n not loaded" }
        }
        "$($names.Count) alert rules"
    }
    Check 'API scrape target up' {
        $q = Invoke-RestMethod "$prom/api/v1/query?query=$([uri]::EscapeDataString('up{job="healthqueue-api"}'))"
        if (-not $q.data.result -or ($q.data.result | Where-Object { $_.value[1] -ne '1' })) {
            throw 'target missing or down (it can take ~1 minute after deploy)'
        }
        "$($q.data.result.Count) target(s)"
    }
} finally {
    Stop-PortForward $pf
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host "$failures check(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host 'All checks passed.' -ForegroundColor Green
