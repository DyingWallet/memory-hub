# Remove the daily backup scheduled task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-backup-task.ps1
param(
  [string]$TaskName = 'memd-backup'
)

$ErrorActionPreference = 'Stop'
schtasks /Delete /TN $TaskName /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks delete failed with exit $LASTEXITCODE" }
Write-Host "removed task '$TaskName'"
