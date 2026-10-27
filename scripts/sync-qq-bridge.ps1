<#
  sync-qq-bridge.ps1 - copy the vendored qq-bridge source (memory-hub/qq-bridge)
  onto a deployment directory.

  Since 2026-10-25 the source of truth is `memory-hub/qq-bridge/`. The deployment
  directory (default `..\qq-bridge`) only owns the runtime bits: state/,
  config.json, node_modules/, logs/. Those are never touched or deleted here.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\sync-qq-bridge.ps1           # preview
    powershell -ExecutionPolicy Bypass -File scripts\sync-qq-bridge.ps1 -Apply    # sync
    powershell -ExecutionPolicy Bypass -File scripts\sync-qq-bridge.ps1 -Apply -Restart

  Exit codes: 0 no diff / synced, 1 diff found but -Apply missing, 2 failure.
#>
[CmdletBinding()]
param(
  [string]$Target = '',
  [switch]$Apply,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'qq-bridge'
if (-not (Test-Path -LiteralPath $source)) { throw "source not found: $source" }

if (-not $Target) { $Target = Join-Path (Split-Path -Parent $repo) 'qq-bridge' }
$Target = [System.IO.Path]::GetFullPath($Target)
if (-not (Test-Path -LiteralPath $Target)) { throw "target not found: $Target" }
if ($Target.TrimEnd('\') -eq $source.TrimEnd('\')) { throw 'source and target are the same directory' }

$excludeDirs = @('state', 'node_modules', 'logs', 'audio', '.git', '.npm-cache')
$excludeFiles = @('config.json', 'local-paths.ps1', '_friends.mjs', '_setgroup.cjs', '*.log', '*.bak', '*.bak-*')

$common = @($source, $Target, '/E', '/XD') + $excludeDirs + @('/XF') + $excludeFiles + @('/NFL', '/NDL', '/NJH', '/NP', '/R:1', '/W:1')

Write-Host "source: $source"
Write-Host "target: $Target"

if (-not $Apply) {
  Write-Host ''
  Write-Host '--- preview only (nothing is changed; add -Apply to sync) ---'
  robocopy @common /L | Select-Object -Last 20
  $code = $LASTEXITCODE
  if ($code -ge 8) { Write-Error "robocopy failed ($code)" }
  # robocopy 的位含义：1 = 有文件要复制，2 = 目标有 extras（state/ config/ 之类，正常）。
  # 只看 bit0：只有「真的要复制文件」才算有差异。
  if (($code -band 1) -ne 0) { Write-Host ''; Write-Host "diff found (robocopy $code). Re-run with -Apply." ; exit 1 }
  Write-Host 'no diff.'
  exit 0
}

Write-Host ''
Write-Host '--- syncing ---'
robocopy @common | Select-Object -Last 15
$code = $LASTEXITCODE
if ($code -ge 8) { Write-Error "robocopy failed ($code)" }

# Bridge console port comes from the target config.json (consolePort). The
# deployed config.json is runtime-owned and never synced, so read it there.
$bridgePort = 3100
try {
  $cfg = Get-Content -LiteralPath (Join-Path $Target 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.consolePort) { $bridgePort = [int]$cfg.consolePort }
} catch { }

if ($Restart) {
  Write-Host ''
  Write-Host "--- restarting bridge (stop whatever listens on $bridgePort) ---"
  $listeners = Get-NetTCPConnection -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "stopped pid $($l.OwningProcess)"
  }
  Start-Sleep -Milliseconds 800
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start.bat' -WorkingDirectory $Target -WindowStyle Hidden
  Write-Host 'bridge restarted (start.bat, hidden window)'
}

Write-Host ''
Write-Host "done (robocopy $code). state/ config.json node_modules/ logs/ were not touched."
if (-not $Restart) {
  Write-Host "If the bridge is running, restart it to pick up the new code: stop the process on $bridgePort, then start.bat."
}
exit 0
