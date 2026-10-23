# Register an hourly memory-hub health sample task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-monitor-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-monitor-task.ps1 -EveryMinutes 30
#
# Uninstall with scripts\uninstall-monitor-task.ps1.
param(
  [int]$EveryMinutes = 60,
  [string]$TaskName = 'memd-monitor'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
$script = Join-Path $root 'scripts\monitor.mjs'
$command = "`"$node`" `"$script`""

schtasks /Create /TN $TaskName /SC MINUTE /MO $EveryMinutes /TR $command /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks failed with exit $LASTEXITCODE" }

Write-Host "installed task '$TaskName' every $EveryMinutes minute(s)"
Write-Host "action: $command"
Write-Host "remove with: powershell -ExecutionPolicy Bypass -File scripts\uninstall-monitor-task.ps1"
