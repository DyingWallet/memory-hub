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
$node = $env:MEMD_NODE
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $candidates = @(
    'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { $node = $candidate; break }
  }
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
  $health = Invoke-RestMethod 'http://127.0.0.1:8787/v1/health' -TimeoutSec 5
  Add-Result 'memd 8787' $true ("docs={0} facts={1} chunks={2}" -f $health.index.docs, $health.index.facts, $health.index.chunks)
} catch {
  Add-Result 'memd 8787' $false $_.Exception.Message
}

# 2. doctor (plugins + mcp + token + memd + disclosure)
$doctorJson = Join-Path $env:TEMP 'memory-hub-doctor.json'
& $node (Join-Path $root 'scripts\doctor.mjs') --json > $doctorJson 2>&1
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
  Add-Result 'pet-llm 8790' $true 'skipped'
} else {
  $petEntry = Join-Path (Split-Path $root -Parent) 'dsh-pet-configurable-llm\src\index.mjs'
  if (Test-Path -LiteralPath $petEntry) {
    & $node $petEntry --check *> $null
    Add-Result 'pet-llm 8790' ($LASTEXITCODE -eq 0) ("--check exit={0}" -f $LASTEXITCODE)
  } else {
    Add-Result 'pet-llm 8790' $false 'dsh-pet-configurable-llm not found'
  }
}

# 4. qq bridge
$bridgeUp = Test-NetConnection 127.0.0.1 -Port 3100 -InformationLevel Quiet -WarningAction SilentlyContinue
Add-Result 'qq-bridge 3100' ([bool]$bridgeUp) $(if ($bridgeUp) { 'listening' } else { 'not listening (start it, or ignore if you do not use QQ)' })

$width = ($results | ForEach-Object { $_.Item.Length } | Measure-Object -Maximum).Maximum
foreach ($row in $results) {
  $mark = if ($row.Ok) { 'OK  ' } else { 'FAIL' }
  Write-Host ("{0}  {1}  {2}" -f $mark, $row.Item.PadRight($width), $row.Detail)
}

$failedCore = @($results | Where-Object { -not $_.Ok -and $_.Item -ne 'qq-bridge 3100' })
if ($failedCore.Count -eq 0) {
  Write-Host "`nall checks passed"
  exit 0
}
Write-Host ("`n{0} check(s) failed" -f $failedCore.Count)
exit 1
