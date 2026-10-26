<#
.SYNOPSIS
  Sends traffic to the local API, optionally injecting failures and slow
  responses (the local overlay sets CHAOS_ENABLED=true), so you can watch the
  SLIs move and the multi-window burn-rate alerts fire.

.EXAMPLE
  .\scripts\local\load.ps1 -Minutes 15 -ErrorPercent 20
  # ~20% errors is ~40x the availability budget: the fast-burn page fires in
  # roughly 5 minutes (5m window + 2m "for"). Watch it in Alertmanager.
#>
[CmdletBinding()]
param(
    [string]$ClusterName = 'healthqueue',
    [ValidateRange(1, 120)][int]$Minutes = 5,
    [ValidateRange(1, 50)][int]$RequestsPerSecond = 5,
    [ValidateRange(0, 100)][int]$ErrorPercent = 0,
    [ValidateRange(0, 100)][int]$SlowPercent = 0
)

. (Join-Path $PSScriptRoot 'common.ps1')

$pf = Start-PortForward -Context $ClusterName -Namespace 'healthqueue-local' -Target 'svc/healthqueue-api' -LocalPort 18081 -RemotePort 80
$counts = @{ ok = 0; error = 0; slow = 0 }
$rand = New-Object System.Random
$end = (Get-Date).AddMinutes($Minutes)
$interval = [int](1000 / $RequestsPerSecond)
Write-Step "Sending ~$RequestsPerSecond req/s for $Minutes min (errors $ErrorPercent%, slow $SlowPercent%). Ctrl+C to stop."
try {
    while ((Get-Date) -lt $end) {
        $roll = $rand.Next(100)
        $headers = @{}
        if ($roll -lt $ErrorPercent) { $headers['x-chaos'] = 'error' }
        elseif ($roll -lt $ErrorPercent + $SlowPercent) { $headers['x-chaos'] = 'slow' }
        $body = @{ acuity = $rand.Next(1, 6); patientsAhead = $rand.Next(0, 30); cliniciansOnShift = $rand.Next(1, 6) } | ConvertTo-Json
        try {
            Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:18081/api/v1/estimate' -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 5 | Out-Null
            if ($headers['x-chaos'] -eq 'slow') { $counts.slow++ } else { $counts.ok++ }
        } catch {
            $counts.error++
        }
        $total = $counts.ok + $counts.error + $counts.slow
        if ($total % 50 -eq 0) {
            Write-Host ("  {0:HH:mm:ss}  sent {1,6}  ok {2,6}  slow {3,5}  errors {4,5}" -f (Get-Date), $total, $counts.ok, $counts.slow, $counts.error)
        }
        Start-Sleep -Milliseconds $interval
    }
} finally {
    Stop-PortForward $pf
    Write-Host ("Done: {0} ok, {1} slow, {2} errors." -f $counts.ok, $counts.slow, $counts.error)
}
