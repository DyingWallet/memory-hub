# Start memd (the memory service) in the background, wait for /v1/health, and
# report the result. Safe to run when memd is already up (it just health-checks).
#
#   .\scripts\start.ps1                # start + wait up to 15s
#   .\scripts\start.ps1 -NoWait        # fire and forget
#   .\scripts\start.ps1 -Foreground    # run in this console (dev)
param(
  [switch]$NoWait,
  [switch]$Foreground,
  [int]$TimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'memd.log'

function Resolve-Node {
  # Order: MEMD_NODE -> workspace tools\node (portable, preferred) -> DSH bundled -> PATH.
  # All candidates must be >= 22.12 (node:sqlite). The DSH bundled one comes last,
  # because running it locks the DSH install dir (SHARING_VIOLATION 32 on upgrade).
  $candidates = @()
  if ($env:MEMD_NODE) { $candidates += $env:MEMD_NODE }
  if ($env:NODE_EXE) { $candidates += $env:NODE_EXE }
  $candidates += (Join-Path $root '..\tools\node\node.exe')
  $candidates += 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath) { $candidates += $fromPath.Source }
  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
    $full = (Resolve-Path -LiteralPath $candidate).Path
    $version = (& $full --version 2>$null)
    if ($version -match '^v(\d+)\.(\d+)' -and ([int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 12))) {
      return $full
    }
  }
  throw 'node.exe >= 22.12 not found; set $env:MEMD_NODE or run pnpm fetch:node'
}

$node = Resolve-Node
$entry = Join-Path $root 'packages\server\dist\index.js'
if (-not (Test-Path $entry)) {
  throw "missing build output: $entry (run: pnpm run build)"
}

$configPath = Join-Path $root 'config.json'
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $root 'config.example.json') $configPath
  Write-Host "created $configPath from config.example.json"
}

$port = 8787
try { $port = (Get-Content $configPath -Raw | ConvertFrom-Json).port } catch { }

# Already running? Health check is enough.
$healthUrl = "http://127.0.0.1:$port/v1/health"
try {
  $probe = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  if ($probe.ok) { Write-Host "memd already running on $port"; exit 0 }
} catch { }

if ($Foreground) {
  & $node $entry
  exit $LASTEXITCODE
}

$out = Join-Path $logDir 'memd.out.log'
$err = Join-Path $logDir 'memd.err.log'
$process = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $root `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Set-Content -Path (Join-Path $logDir 'memd.pid') -Value $process.Id -Encoding ASCII
Write-Host "memd started (pid $($process.Id)), log: $logFile"

if ($NoWait) { exit 0 }

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  try {
    $probe = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($probe.ok) {
      Write-Host ("memd healthy on {0} (docs={1} facts={2} chunks={3})" -f $port, $probe.index.docs, $probe.index.facts, $probe.index.chunks)
      exit 0
    }
  } catch { }
  if ($process.HasExited) {
    Write-Error "memd exited early (code $($process.ExitCode)); see $err"
    exit 1
  }
}
Write-Error "memd did not become healthy within $TimeoutSec s; see $err"
exit 1
