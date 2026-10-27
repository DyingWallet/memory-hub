# Stop memd by pid file, then by port fallback.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'logs\memd.pid'

# memd port comes from config.json (port); default 8787. Never hardcode it here.
$port = 8787
try {
  $cfg = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
} catch { }

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

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "stopped memd on port $port (pid $($listener.OwningProcess))"
}
