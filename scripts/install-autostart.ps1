# Register memory-hub's single watchdog task (v2).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Check
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#
# One task, every minute: scripts\supervisor.mjs does everything -
#
#   * memd alive? start it with scripts\start.ps1 -NoWait (idempotent, health first)
#   * data\metrics.csv older than 60 min? run scripts\monitor.mjs
#   * no backup snapshot for today, past 04:00? run scripts\backup.mjs
#
# It replaced four separate tasks (memd-autostart / memd-watchdog / memd-monitor /
# memd-backup): one trigger to maintain, one log, one place to look. The old tasks
# are removed by this script if they are still registered.
#
# The action goes through wscript.exe + scripts\run-hidden.vbs because Task
# Scheduler flashes a console window for any console program it starts directly.
# A 1-minute task makes that flash very visible.
#
# pet-brain has NO task here: it follows the DSH lifecycle (qq-bridge\start-stack.ps1
# step 2.7 starts it, dsh-pet-configurable-llm/scripts/install-revive-task.ps1 keeps
# it alive while DSH runs).
#
# Must run from a normal (non-sandbox) PowerShell: the DSH sandbox is a low
# integrity process and gets "access denied" from the Task Scheduler.
param(
  [int]$EveryMinutes = 1,
  [string]$TaskName = 'memd-watchdog',
  [switch]$Check,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'supervisor.mjs'
$runHidden = Join-Path $PSScriptRoot 'run-hidden.vbs'
$legacyTasks = @('memd-autostart', 'memd-monitor', 'memd-backup')

$node = $env:MEMD_NODE
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $node = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $node)) {
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath) { $node = $fromPath.Source }
}
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }

function Get-ExistingTask([string]$Name) {
  try { return Get-ScheduledTask -TaskName $Name -ErrorAction Stop } catch { return $null }
}

function Show-TaskState([string]$Name) {
  $task = Get-ExistingTask $Name
  if ($null -eq $task) { Write-Host ("{0,-16} missing" -f $Name); return $false }
  $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
  $repeat = ''
  $repetition = $task.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
  if ($repetition) {
    # duration '' == repeat indefinitely
    $repeat = " every=$($repetition.Repetition.Interval) duration='$($repetition.Repetition.Duration)'"
  }
  Write-Host ("{0,-16} {1,-8} last={2} result={3} next={4}{5}" -f $Name, $task.State, $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime, $repeat)
  return $true
}

if ($Check) {
  $ok = Show-TaskState $TaskName
  foreach ($path in @($supervisor, $runHidden, $node)) {
    if (-not (Test-Path -LiteralPath $path)) {
      Write-Host "missing: $path"
      $ok = $false
    }
  }
  $tick = Join-Path $root 'logs\task-last-tick.txt'
  if (Test-Path -LiteralPath $tick) {
    Write-Host ('last tick:      ' + (Get-Content -LiteralPath $tick -Encoding UTF8 -Raw).Trim())
  }
  else { Write-Host 'last tick:      (no heartbeat yet)' }
  $supLog = Join-Path $root 'logs\supervisor.log'
  if (Test-Path -LiteralPath $supLog) {
    Write-Host ('last event:     ' + (Get-Content -LiteralPath $supLog -Encoding UTF8 -Tail 1))
  }
  else { Write-Host 'last event:     (nothing has needed attention yet)' }
  foreach ($name in $legacyTasks) {
    if (Get-ExistingTask $name) { Write-Host "legacy task still registered: $name (re-run without -Check to remove it)" }
  }
  if ($ok) { Write-Host 'watchdog ready' } else { Write-Host 'watchdog incomplete' }
  exit $(if ($ok) { 0 } else { 1 })
}

if ($Remove) {
  foreach ($name in @($TaskName) + $legacyTasks) {
    if (Get-ExistingTask $name) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "removed task '$name'"
    }
    else { Write-Host "task '$name' not present" }
  }
  Write-Host 'watchdog removed; a running memd is left alone (scripts\stop.ps1 stops it)'
  exit 0
}

foreach ($path in @($supervisor, $runHidden, $node)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "missing $path" }
  if ($path -match '\s') { throw "path contains spaces, quoting would break: $path" }
}
if ($EveryMinutes -lt 1 -or $EveryMinutes -gt 60) { throw 'EveryMinutes must be 1-60' }

$action = New-ScheduledTaskAction -Execute $wscriptExe `
  -Argument ('{0} {1} {2} {3}' -f '//nologo', $runHidden, $node, $supervisor) `
  -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited

# schtasks /TR is capped at 261 characters and this action is close to the limit,
# so create the task with a throwaway action (that is what writes the indefinite
# repetition) and swap the real action in through the cmdlets.
schtasks /Create /TN $TaskName /SC MINUTE /MO $EveryMinutes /TR 'cmd.exe /c exit' /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed with exit $LASTEXITCODE" }
Set-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Principal $principal | Out-Null
Write-Host ("installed '{0}': every {1} min -> {2}" -f $TaskName, $EveryMinutes, $supervisor)

foreach ($name in $legacyTasks) {
  if (Get-ExistingTask $name) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed legacy task '$name'"
  }
}

Write-Host ''
Show-TaskState $TaskName | Out-Null
Write-Host ''
Write-Host 'run the supervisor once now: & <node> scripts\supervisor.mjs'
Write-Host 'verify:                     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Check'
Write-Host 'remove:                     powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1'
