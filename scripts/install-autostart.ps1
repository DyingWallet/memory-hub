# Register memd's v2 autostart: one logon task plus one 5-minute watchdog.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Check
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#
# Both tasks run scripts\start.ps1 -NoWait as the current user (no admin needed).
# start.ps1 probes /v1/health first and exits 0 when memd is already healthy, so
# the two triggers can never fight over the port:
#   memd-autostart   30 seconds after logon
#   memd-watchdog    every 5 minutes; picks memd up again if it died
#
# pet-brain is deliberately NOT registered here. It only serves the DSH
# pet-chat preset, so it follows DSH instead: qq-bridge\start-stack.ps1 starts it
# (step 2.7) and it exits on its own after 3 x 30s without DSH (src/guard.mjs).
#
# Must run from a normal (non-sandbox) PowerShell: the DSH sandbox is a low
# integrity process and gets "access denied" from the Task Scheduler.
param(
  [int]$LogonDelaySeconds = 30,
  [int]$WatchdogMinutes = 5,
  [string]$AutostartTask = 'memd-autostart',
  [string]$WatchdogTask = 'memd-watchdog',
  [switch]$Check,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $root 'scripts\start.ps1'
$taskNames = @($AutostartTask, $WatchdogTask)

$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershellExe)) { $powershellExe = 'powershell.exe' }

function Get-ExistingTask([string]$Name) {
  try { return Get-ScheduledTask -TaskName $Name -ErrorAction Stop } catch { return $null }
}

function Show-TaskState([string]$Name) {
  $task = Get-ExistingTask $Name
  if ($null -eq $task) { Write-Host ("{0,-16} missing" -f $Name); return $false }
  $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
  $last = if ($info) { $info.LastRunTime } else { $null }
  $result = if ($info) { $info.LastTaskResult } else { $null }
  $next = if ($info) { $info.NextRunTime } else { $null }
  $repeat = ''
  $repetition = $task.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
  if ($repetition) {
    # duration '' == repeat indefinitely (the watchdog's expected shape)
    $repeat = " every=$($repetition.Repetition.Interval) duration='$($repetition.Repetition.Duration)'"
  }
  Write-Host ("{0,-16} {1,-8} last={2} result={3} next={4}{5}" -f $Name, $task.State, $last, $result, $next, $repeat)
  return $true
}

if ($Check) {
  $ok = $true
  foreach ($name in $taskNames) {
    if (-not (Show-TaskState $name)) { $ok = $false }
  }
  if (-not (Test-Path -LiteralPath $startScript)) {
    Write-Host "missing action script: $startScript"
    $ok = $false
  }
  if ($ok) { Write-Host 'autostart ready' } else { Write-Host 'autostart incomplete' }
  exit $(if ($ok) { 0 } else { 1 })
}

if ($Remove) {
  foreach ($name in $taskNames) {
    if (Get-ExistingTask $name) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "removed task '$name'"
    }
    else { Write-Host "task '$name' not present" }
  }
  Write-Host 'memd autostart removed; a running memd is left alone (scripts\stop.ps1 stops it)'
  exit 0
}

if (-not (Test-Path -LiteralPath $startScript)) { throw "missing $startScript" }
if ($startScript -match '\s') { throw "action path contains spaces, quoting would break: $startScript" }
if ($LogonDelaySeconds -lt 0 -or $LogonDelaySeconds -gt 600) { throw 'LogonDelaySeconds must be 0-600' }
if ($WatchdogMinutes -lt 1 -or $WatchdogMinutes -gt 60) { throw 'WatchdogMinutes must be 1-60' }

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -NoWait' -f $startScript
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited

# 1. logon task
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME)
$logonTrigger.Delay = 'PT{0}S' -f $LogonDelaySeconds
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $argument -WorkingDirectory $root
Register-ScheduledTask -TaskName $AutostartTask -Action $action -Trigger $logonTrigger `
  -Settings $settings -Principal $principal -Force `
  -Description "Start memd (memory-hub) ${LogonDelaySeconds}s after logon; exit 0 when already healthy" | Out-Null
Write-Host ("installed '{0}': at logon +{1}s -> {2}" -f $AutostartTask, $LogonDelaySeconds, $startScript)

# 2. watchdog task: every N minutes, forever.
#
# Do NOT use -RepetitionDuration ([TimeSpan]::MaxValue) here: it serializes to
# P99999999DT23H59M59S and some builds reject it at Register time with
# 0x80041318 "Duration out of range" (hit on this machine 2026-10-24). Creating
# the task with schtasks /SC MINUTE writes a repetition without a <Duration>
# element, which is exactly the UI's "Indefinitely"; settings are patched in
# afterwards so the watchdog still gets StartWhenAvailable / IgnoreNew.
#
# The path is checked for spaces above, so the action needs no quotes — that
# keeps this value intact when PowerShell hands it to schtasks as one argument.
$plainArgument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File {0} -NoWait' -f $startScript
$actionCommand = '{0} {1}' -f $powershellExe, $plainArgument
schtasks /Create /TN $WatchdogTask /SC MINUTE /MO $WatchdogMinutes /TR $actionCommand /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed with exit $LASTEXITCODE" }
try {
  Set-ScheduledTask -TaskName $WatchdogTask -Settings $settings -Principal $principal | Out-Null
}
catch {
  Write-Warning ("watchdog task created, but its settings were not applied: " + $_.Exception.Message)
}
Write-Host ("installed '{0}': every {1} min -> {2}" -f $WatchdogTask, $WatchdogMinutes, $startScript)

# Report the repetition the scheduler actually stored (indefinite => no duration).
try {
  $repetition = (Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction Stop).Triggers[0].Repetition
  Write-Host ("  repetition: interval={0} duration='{1}'" -f $repetition.Interval, $repetition.Duration)
}
catch {
  Write-Warning ("could not read back the repetition: " + $_.Exception.Message)
}

Write-Host ''
if (-not (Show-TaskState $AutostartTask)) { throw "task '$AutostartTask' not found after install" }
if (-not (Show-TaskState $WatchdogTask)) { throw "task '$WatchdogTask' not found after install" }
Write-Host ''
Write-Host 'start memd right now: powershell -ExecutionPolicy Bypass -File scripts\start.ps1'
Write-Host 'verify:              powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Check'
Write-Host 'remove:              powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1'
