# Post-upgrade check for the whole local stack.
#
#   powershell -ExecutionPolicy Bypass -File scripts\post-upgrade.ps1
#
# Run it after installing a new DSH build and restarting DSH Desktop. It checks
# the three integrations we own (memd, the two DSH plugins, pet-llm) and prints a
# short table. Exit 0 = everything reachable; 1 = at least one core item failed.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
param(
  [switch]$SkipPetCheck
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

# Port single source of truth: each service owns its own config.json.
# Never hardcode 8787 / 3100 / 8790 here - if a config.json changes, this check
# must follow automatically, otherwise it reports a false FAIL.
$stackRoot    = Split-Path $root -Parent
$memdConfig   = Join-Path $root 'config.json'
$bridgeConfig = Join-Path $stackRoot 'qq-bridge\config.json'
$petConfig    = Join-Path $stackRoot 'dsh-pet-configurable-llm\config.json'

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

$memdPort   = Read-Port $memdConfig @('port') 8787
$bridgePort = Read-Port $bridgeConfig @('consolePort') 3100
$petPort    = Read-Port $petConfig @('listen', 'port') 8790
$memdItem   = "memd $memdPort"
$petItem    = "pet-llm $petPort"
$bridgeItem = "qq-bridge $bridgePort"

$node = $env:MEMD_NODE
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  # Order: MEMD_NODE -> workspace tools\node (portable) -> DSH bundled -> PATH
  $portable = Join-Path $root '..\tools\node\node.exe'
  if (Test-Path -LiteralPath $portable) { $node = (Resolve-Path -LiteralPath $portable).Path }
}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $dshNode = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $dshNode) { $node = $dshNode }
}
if (-not $node) {
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath) { $node = $fromPath.Source }
}
if (-not $node) { Write-Host 'FAIL: node.exe not found (set MEMD_NODE)'; exit 1 }

$results = @()
function Add-Result([string]$name, [bool]$ok, [string]$detail) {
  $script:results += [pscustomobject]@{ Item = $name; Ok = $ok; Detail = $detail }
}

# 1. memd
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$memdPort/v1/health" -TimeoutSec 5
  Add-Result $memdItem $true ("docs={0} facts={1} chunks={2}" -f $health.index.docs, $health.index.facts, $health.index.chunks)
} catch {
  Add-Result $memdItem $false $_.Exception.Message
}

# 2. doctor (plugins + mcp + token + memd + disclosure)
$doctorJson = Join-Path $env:TEMP 'memory-hub-doctor.json'
# Decode native stdout as UTF-8, otherwise PS 5.1 uses the ANSI codepage (GBK)
# and mangles the Chinese labels in doctor's JSON, breaking ConvertFrom-Json.
$prevOutEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
& $node (Join-Path $root 'scripts\doctor.mjs') --json 2>&1 | Out-File -FilePath $doctorJson -Encoding utf8
try { [Console]::OutputEncoding = $prevOutEnc } catch { }
$doctorExit = $LASTEXITCODE
try {
  $doctor = Get-Content $doctorJson -Raw | ConvertFrom-Json
  $failed = @($doctor.checks | Where-Object { -not $_.ok -and $_.critical } | ForEach-Object { $_.id })
  $warns = @($doctor.checks | Where-Object { -not $_.ok -and -not $_.critical } | ForEach-Object { $_.id })
  $detail = "ready={0} failed=[{1}]" -f $doctor.ready, ($failed -join ',')
  if ($warns.Count -gt 0) { $detail = $detail + (" warn=[{0}]" -f ($warns -join ',')) }
  Add-Result 'doctor' ([bool]$doctor.ready) $detail
} catch {
  Add-Result 'doctor' $false 'could not parse doctor output'
}
Remove-Item $doctorJson -ErrorAction SilentlyContinue

# 3. pet-llm
if ($SkipPetCheck) {
  Add-Result $petItem $true 'skipped'
} else {
  $petEntry = Join-Path (Split-Path $root -Parent) 'dsh-pet-configurable-llm\src\index.mjs'
  if (Test-Path -LiteralPath $petEntry) {
    & $node $petEntry --check *> $null
    Add-Result $petItem ($LASTEXITCODE -eq 0) ("--check exit={0}" -f $LASTEXITCODE)
  } else {
    Add-Result $petItem $false 'dsh-pet-configurable-llm not found'
  }
}

# 4. qq bridge
$bridgeUp = Test-NetConnection 127.0.0.1 -Port $bridgePort -InformationLevel Quiet -WarningAction SilentlyContinue
Add-Result $bridgeItem ([bool]$bridgeUp) $(if ($bridgeUp) { 'listening' } else { 'not listening (start it, or ignore if you do not use QQ)' })

$width = ($results | ForEach-Object { $_.Item.Length } | Measure-Object -Maximum).Maximum
foreach ($row in $results) {
  $mark = if ($row.Ok) { 'OK  ' } else { 'FAIL' }
  Write-Host ("{0}  {1}  {2}" -f $mark, $row.Item.PadRight($width), $row.Detail)
}

$failedCore = @($results | Where-Object { -not $_.Ok -and $_.Item -ne $bridgeItem })
if ($failedCore.Count -eq 0) {
  Write-Host "`nall checks passed"
  exit 0
}
Write-Host ("`n{0} check(s) failed" -f $failedCore.Count)
exit 1
