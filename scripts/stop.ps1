# Stop memd by pid file, then by port fallback.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'logs\memd.pid'

if (Test-Path $pidFile) {
  $processId = (Get-Content $pidFile -Raw).Trim()
  if ($processId) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      Write-Host "stopped memd (pid $processId)"
    } else {
      Write-Host "pid $processId not running"
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

$listeners = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "stopped memd on port 8787 (pid $($listener.OwningProcess))"
}
