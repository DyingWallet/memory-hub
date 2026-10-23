# Register a daily Windows Scheduled Task for memory-hub backups.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -At 03:30
#
# The task runs as the current user at logon-less schedule (daily); it does not
# require admin. Uninstall with scripts\uninstall-backup-task.ps1.
param(
  [string]$At = '04:00',
  [string]$TaskName = 'memd-backup'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
$script = Join-Path $root 'scripts\backup.mjs'
$command = "`"$node`" `"$script`""

schtasks /Create /TN $TaskName /SC DAILY /ST $At /TR $command /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks failed with exit $LASTEXITCODE" }

Write-Host "installed task '$TaskName' daily at $At"
Write-Host "action: $command"
Write-Host "remove with: powershell -ExecutionPolicy Bypass -File scripts\uninstall-backup-task.ps1"
