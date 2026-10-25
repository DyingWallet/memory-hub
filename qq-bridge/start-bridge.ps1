<#
  Start qq-bridge against the running DeepSeek Harness desktop app.

  The desktop app listens on a random loopback port that changes on every
  restart, so this script finds the current one, writes it into config.json
  and then starts the bridge in the foreground (Ctrl+C to stop).

  Usage:
    powershell -ExecutionPolicy Bypass -File .\start-bridge.ps1
    powershell -ExecutionPolicy Bypass -File .\start-bridge.ps1 -DetectOnly

  Notes:
    - DSH must be running first.
    - snowluma.* in config.json must point at your SnowLuma OneBot endpoints.
    - allow.private / ownerQQ must contain your own QQ number, otherwise the
      bridge ignores every message (fail-closed default).
#>
[CmdletBinding()]
param([switch]$DetectOnly, [int]$Port = 0)

$ErrorActionPreference = 'Stop'

$root       = $PSScriptRoot
$configPath = Join-Path $root 'config.json'
$nodeExe    = $env:MEMD_NODE
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  # Workspace portable node first: keeping the bridge on the DSH bundled node.exe
  # locks the DSH install dir and makes an upgrade fail with WinError 32.
  $portable = Join-Path $root '..\tools\node\node.exe'
  if (Test-Path -LiteralPath $portable) { $nodeExe = (Resolve-Path -LiteralPath $portable).Path }
}
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  # 最后退回 PATH 上的 node（>= 22.12，需要 node:sqlite）。仓库里不写死任何本机路径。
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath) { $nodeExe = $fromPath.Source }
}
$patchJs    = Join-Path $root 'set-dsh-url.cjs'

if (-not (Test-Path -LiteralPath $nodeExe))    { throw "node.exe not found: $nodeExe" }
if (-not (Test-Path -LiteralPath $configPath)) { throw "config.json not found: $configPath (copy config.example.json first)" }

function Test-DshPort([int]$Port) {
    # A plain 401 is not enough: other loopback services (e.g. 2013) also answer
    # 401 with an empty body. DSH's unauthenticated response carries a fixed
    # marker text, which is what dsh-endpoint.mjs probes for too.
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $false
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return $false }
        if ([int]$resp.StatusCode -ne 401) { return $false }
        try {
            $stream = $resp.GetResponseStream()
            if ($null -eq $stream) { return $false }
            $reader = New-Object System.IO.StreamReader($stream)
            $body = $reader.ReadToEnd()
            $reader.Close()
        }
        catch { return $false }
        return ($body -match 'dsh web authentication required')
    }
}

function Get-DshPort {
    # The harness exports DSH_WEB_URL for the instance that is actually running.
    # Prefer it: stale DSH processes may still hold older ports and answer 401.
    if ($env:DSH_WEB_URL) {
        try {
            $u = [Uri]$env:DSH_WEB_URL
            if ($u.Host -in @('127.0.0.1', 'localhost') -and (Test-DshPort $u.Port)) { return $u.Port }
        }
        catch { }
    }
    foreach ($p in 19387, 3080) {
        if (Test-DshPort $p) { return $p }
    }
    $ports = @()
    foreach ($line in (netstat -ano -p TCP 2>$null)) {
        if ($line -match 'LISTENING' -and $line -match '127\.0\.0\.1:(\d+)\s') { $ports += [int]$Matches[1] }
    }
    foreach ($p in ($ports | Sort-Object -Unique)) {
        if (Test-DshPort $p) { return $p }
    }
    return $null
}

$port = if ($Port -gt 0) { $Port } else { Get-DshPort }
if (-not $port) {
    throw 'DSH web port not found. Is DeepSeek Harness running?'
}
Write-Host ("DSH web port : {0}" -f $port)

$baseUrl = & $nodeExe $patchJs $port
Write-Host ("config.json  : {0}" -f $baseUrl)

if ($DetectOnly) {
    $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ("ownerQQ      : {0}" -f $cfg.ownerQQ)
    Write-Host ("allow.private: {0}" -f (($cfg.allow.private) -join ', '))
    Write-Host ("snowluma.ws  : {0}" -f $cfg.snowluma.wsUrl)
    return
}

$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs -Force | Out-Null }
$outLog = Join-Path $logs 'bridge.out.log'
$errLog = Join-Path $logs 'bridge.err.log'

Write-Host ("starting bridge (log: {0})" -f $outLog)
$proc = Start-Process -FilePath $nodeExe `
    -ArgumentList (Join-Path $root 'src\bridge.js') `
    -WorkingDirectory $root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru
Write-Host ("bridge pid: {0}" -f $proc.Id)
