<#
.SYNOPSIS
  Downloads the validation CLIs CI uses (same versions) into .tools\bin and
  verifies each archive against a pinned SHA-256. Used by scripts\check.ps1.
  Linux counterpart: scripts/ci/install-tools.sh.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')
$bin = Join-Path $RepoRoot '.tools\bin'
$tmp = Join-Path $env:TEMP "healthqueue-tools-$PID"
New-Item -ItemType Directory -Force $bin, $tmp | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$tools = @(
    @{ Name = 'kubeconform.exe'; Sha = 'e3f56102bcf4f50b034a567e2482a1c5330799983ddd655952310211aef73d93'
       Url = 'https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-windows-amd64.zip' },
    @{ Name = 'promtool.exe'; Sha = 'ba25b5e590520cb9fb028edef99bdc8523244d2d489b8c629e0d453d94fb030b'
       Url = 'https://github.com/prometheus/prometheus/releases/download/v3.15.1/prometheus-3.15.1.windows-amd64.zip' },
    @{ Name = 'kyverno.exe'; Sha = 'c787cd56d2c2571e5470b1d070fff851c05d104513fcf5cb1652021bb187a1f6'
       Url = 'https://github.com/kyverno/kyverno/releases/download/v1.19.2/kyverno-cli_v1.19.2_windows_x86_64.zip' },
    @{ Name = 'actionlint.exe'; Sha = '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'
       Url = 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip' },
    # GitHub's Ubuntu runners ship shellcheck and actionlint uses it to lint
    # every `run:` block; without it locally, those findings only appear in CI.
    # ShellCheck publishes no checksum file; this hash was recorded from the
    # v0.11.0 GitHub release asset.
    @{ Name = 'shellcheck.exe'; Sha = '8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e'
       Url = 'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.zip' }
)

try {
    foreach ($t in $tools) {
        $zip = Join-Path $tmp ([IO.Path]::GetFileName($t.Url))
        Write-Step "Downloading $($t.Name)"
        Invoke-WebRequest -UseBasicParsing -Uri $t.Url -OutFile $zip
        $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
        if ($actual -ne $t.Sha) { throw "checksum mismatch for $($t.Name): expected $($t.Sha), got $actual" }
        $extract = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($zip))
        Expand-Archive -Path $zip -DestinationPath $extract -Force
        $exe = Get-ChildItem -Path $extract -Recurse -Filter $t.Name | Select-Object -First 1
        Copy-Item $exe.FullName (Join-Path $bin $t.Name) -Force
        Write-Ok "$($t.Name) (sha256 verified)"
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "Installed to $bin"
