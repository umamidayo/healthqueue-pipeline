# Shared helpers for the local (Windows) scripts. Dot-source, don't run.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) { Write-Host "  [ok]   $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  [warn] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "  [fail] $Message" -ForegroundColor Red }

# Runs a native command and throws if it exits non-zero (PowerShell 5.1 does
# not do this on its own).
function Invoke-Native {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @())
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "'$FilePath $($ArgumentList -join ' ')' failed with exit code $LASTEXITCODE"
    }
}

# Runs a native command whose failure is expected and informative (probes such
# as "is minikube running?"). Returns stdout; stderr is discarded. Windows
# PowerShell 5.1 turns redirected native stderr into terminating errors when
# $ErrorActionPreference is Stop, so relax it for the duration of the call.
function Invoke-Quiet {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $FilePath @ArgumentList 2>$null
        return $out
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Assert-Command([string[]]$Names) {
    $missing = @($Names | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -gt 0) {
        throw ("Missing required tools: {0}. See docs/local-development.md for install commands (winget)." -f ($missing -join ', '))
    }
}

# Starts `kubectl port-forward` in the background and waits until the local
# port accepts connections. Returns the process so the caller can stop it.
function Start-PortForward {
    param(
        [Parameter(Mandatory)][string]$Context,
        [Parameter(Mandatory)][string]$Namespace,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][int]$LocalPort,
        [Parameter(Mandatory)][int]$RemotePort
    )
    $proc = Start-Process -FilePath 'kubectl' -PassThru -WindowStyle Hidden -ArgumentList @(
        '--context', $Context, '-n', $Namespace, 'port-forward', $Target, "$($LocalPort):$($RemotePort)"
    )
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $client.Connect('127.0.0.1', $LocalPort)
            $client.Close()
            return $proc
        } catch {
            $client.Dispose()
        }
        if ($proc.HasExited) { break }
    }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    throw "port-forward to $Namespace/$Target on localhost:$LocalPort did not become ready"
}

function Stop-PortForward($Process) {
    if ($Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
}

function Get-SecretValue([string]$Context, [string]$Namespace, [string]$Name, [string]$Key) {
    $b64 = Invoke-Quiet kubectl @('--context', $Context, '-n', $Namespace, 'get', 'secret', $Name, '-o', "jsonpath={.data.$Key}")
    if (-not $b64) { return $null }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}
