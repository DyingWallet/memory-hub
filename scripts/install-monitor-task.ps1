# Register an hourly memory-hub health sample task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-monitor-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-monitor-task.ps1 -EveryMinutes 30
#
# Uninstall with scripts\uninstall-monitor-task.ps1.
#
# The action goes through wscript.exe + scripts\run-hidden.vbs: running node.exe
# from Task Scheduler directly flashes a console window for the duration of the
# sample (same reason as install-autostart.ps1).
param(
  [int]$EveryMinutes = 60,
  [string]$TaskName = 'memd-monitor'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
$script = Join-Path $root 'scripts\monitor.mjs'
$runHidden = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $runHidden)) { throw "missing $runHidden" }
foreach ($path in @($node, $script, $runHidden)) {
  if ($path -match '\s') { throw "path contains spaces, quoting would break: $path" }
}
# No quotes needed (paths are space-free), which keeps the value intact when
# PowerShell hands it to schtasks as a single argument.
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }
$command = '{0} //nologo {1} {2} {3}' -f $wscriptExe, $runHidden, $node, $script

schtasks /Create /TN $TaskName /SC MINUTE /MO $EveryMinutes /TR $command /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks failed with exit $LASTEXITCODE" }

Write-Host "installed task '$TaskName' every $EveryMinutes minute(s)"
Write-Host "action: $command"
Write-Host "remove with: powershell -ExecutionPolicy Bypass -File scripts\uninstall-monitor-task.ps1"
