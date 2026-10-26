<#
.SYNOPSIS
  Deletes the local minikube profile and the matching OpenTofu state.
  The cluster is disposable; nothing in it is backed up.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([string]$ClusterName = 'healthqueue')

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $RepoRoot

if ($PSCmdlet.ShouldProcess("minikube profile '$ClusterName' and infra/envs/local state", 'Delete')) {
    Invoke-Native minikube @('delete', '-p', $ClusterName)
    Get-ChildItem 'infra/envs/local' -Filter 'terraform.tfstate*' -ErrorAction SilentlyContinue | Remove-Item -Force
    Write-Ok 'local environment removed'
}
