# Stop the qq-bridge by the consolePort configured in its own config.json.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'ports.ps1')
$port = Get-BridgeConsolePort -ConfigPath (Join-Path $root 'config.json')

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
  Write-Host "qq-bridge: nothing listening on $port"
  exit 0
}
foreach ($l in $listeners) {
  try {
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction Stop
    Write-Host "stopped qq-bridge on port $port (pid $($l.OwningProcess))"
  } catch {
    Write-Host "FAILED to stop pid $($l.OwningProcess): $($_.Exception.Message)"
    exit 1
  }
}
