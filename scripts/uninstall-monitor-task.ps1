# Remove the hourly health-sample task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-monitor-task.ps1
param(
  [string]$TaskName = 'memd-monitor'
)

$ErrorActionPreference = 'Stop'
schtasks /Delete /TN $TaskName /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks delete failed with exit $LASTEXITCODE" }
Write-Host "removed task '$TaskName'"
