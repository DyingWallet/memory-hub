# Scheduled-task entry point: start memd hidden and leave a trace behind.
#
# Why this layer exists: run-hidden.vbs starts the process with window style 0, so
# there is no console and start.ps1's stdout/stderr would be lost - a watchdog that
# silently stops working would leave no clue at all. Two files record what happened:
#
#   logs\task-last-tick.txt   overwritten on every trigger (start.ps1 output summary)
#                             -> proves the 1-minute cadence is alive
#   logs\task-start.log       appended only when memd was actually started
#                             -> records real recoveries (rotated past 200KB)
#
# In the normal case (memd already healthy) start.ps1 prints
# "memd already running on 8787" and exits 0, so no event is logged.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 without a BOM as
# ANSI, and a mis-decoded non-ASCII byte can swallow the following quote.
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$tickFile = Join-Path $logDir 'task-last-tick.txt'
$eventFile = Join-Path $logDir 'task-start.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$output = ''
try {
  $output = (& (Join-Path $PSScriptRoot 'start.ps1') -NoWait *>&1 | Out-String).Trim()
} catch {
  $output = "TASK-ENTRY ERROR: $($_.Exception.Message)"
}

$summary = ($output -replace '\s+', ' ').Trim()
if ($summary.Length -gt 400) { $summary = $summary.Substring(0, 400) + '...' }
Set-Content -LiteralPath $tickFile -Value ('{0} | {1}' -f $stamp, $summary) -Encoding UTF8

if ($summary -notmatch 'already running') {
  if ((Test-Path -LiteralPath $eventFile) -and (Get-Item -LiteralPath $eventFile).Length -gt 200KB) {
    Move-Item -LiteralPath $eventFile -Destination "$eventFile.1" -Force
  }
  Add-Content -LiteralPath $eventFile -Value ('--- {0} ---' -f $stamp) -Encoding UTF8
  Add-Content -LiteralPath $eventFile -Value $output -Encoding UTF8
}
