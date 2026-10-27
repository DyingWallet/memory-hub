<#
  Full-stack restart: ask each service to stop itself, then let start-stack.ps1
  bring them back up in the right order.

  This file only orchestrates. It contains no service's start/stop logic:
    memd   -> memory-hub\scripts\start.ps1 / stop.ps1
    pet    -> dsh-pet-configurable-llm\scripts\start.ps1 / stop.ps1
    bridge -> qq-bridge\start-bridge.ps1 / scripts\stop-bridge.ps1
  Start order lives in start-stack.ps1 (this directory).

  - DSH is never touched: it hosts the session you are talking to.
  - SnowLuma is never touched: start-stack.ps1 reuses it when 5099 is up.
  - Ports come from each service's config.json (never hardcoded here).

  Must run from a normal (non-sandbox) PowerShell: qq-bridge\state and
  config.json are ACL-restricted.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\restart-stack.ps1
#>
[CmdletBinding()]
param(
    [int]$WaitSeconds = 180
)

$ErrorActionPreference = 'SilentlyContinue'
$root      = Split-Path -Parent $PSScriptRoot
$stackRoot = Split-Path $root -Parent
$bridgeDir = Join-Path $stackRoot 'qq-bridge'
$petDir    = Join-Path $stackRoot 'dsh-pet-configurable-llm'

function Read-Port([string]$Path, [string[]]$PathParts, [int]$Default) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $Default }
        $cfg = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $cursor = $cfg
        foreach ($part in $PathParts) {
            $cursor = $cursor.$part
            if ($null -eq $cursor) { return $Default }
        }
        $n = [int]$cursor
        if ($n -ge 1 -and $n -le 65535) { return $n }
    } catch { }
    return $Default
}

$bridgePort = Read-Port (Join-Path $bridgeDir 'config.json') @('consolePort') 3100

Write-Host '--- full stack restart ---'

Write-Host '--- stopping (each service stops itself) ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bridgeDir 'scripts\stop-bridge.ps1')
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $petDir 'scripts\stop.ps1')
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\stop.ps1')

# Wait until the bridge port is really released before starting a new instance.
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 300
    if (-not (Get-NetTCPConnection -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue)) { break }
}

Write-Host '--- starting stack (DSH reused if up; SnowLuma reused if up) ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-stack.ps1') -WaitSeconds $WaitSeconds

Write-Host '--- restart done ---'
