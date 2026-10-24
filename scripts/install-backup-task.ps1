# Register a daily Windows Scheduled Task for memory-hub backups.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -At 03:30
#
# The task runs as the current user at logon-less schedule (daily); it does not
# require admin. Uninstall with scripts\uninstall-backup-task.ps1.
#
# The action goes through wscript.exe + scripts\run-hidden.vbs so the console
# window of node.exe never appears (same reason as install-autostart.ps1).
param(
  [string]$At = '04:00',
  [string]$TaskName = 'memd-backup'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
$script = Join-Path $root 'scripts\backup.mjs'
$runHidden = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $runHidden)) { throw "missing $runHidden" }
foreach ($path in @($node, $script, $runHidden)) {
  if ($path -match '\s') { throw "path contains spaces, quoting would break: $path" }
}
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }
# No quotes needed (paths are space-free), which keeps the value intact when
# PowerShell hands it to schtasks as a single argument.
$command = '{0} //nologo {1} {2} {3}' -f $wscriptExe, $runHidden, $node, $script

schtasks /Create /TN $TaskName /SC DAILY /ST $At /TR $command /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks failed with exit $LASTEXITCODE" }

Write-Host "installed task '$TaskName' daily at $At"
Write-Host "action: $command"
Write-Host "remove with: powershell -ExecutionPolicy Bypass -File scripts\uninstall-backup-task.ps1"
