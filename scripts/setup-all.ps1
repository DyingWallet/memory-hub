# One-shot, idempotent deployment for memory-hub.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Check
#   powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Semantic -WithAutostart
#   powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Uninstall
#
# Steps (all idempotent): build -> MCP block + root token -> ingest plugin ->
# settings panel -> optional autostart tasks -> optional semantic search ->
# doctor. Plugins/MCP only load after DSH is restarted; the script never tries
# to restart DSH itself (that would kill the session you are talking to).
#
# Must run from a normal (non-sandbox) PowerShell: ~/.dsh is ACL-restricted.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
param(
  [switch]$Check,
  [switch]$Semantic,
  [switch]$WithAutostart,
  [switch]$Uninstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
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
if (-not $node) { throw 'node.exe not found; set $env:MEMD_NODE' }
function Fail([string]$message) { Write-Host "FAIL: $message" -ForegroundColor Red; exit 1 }

Write-Host "memory-hub setup  (root: $root)"
Write-Host "node: $node"

if ($Check) {
  & $node (Join-Path $root 'scripts\doctor.mjs')
  exit $LASTEXITCODE
}

if ($Uninstall) {
  & $node (Join-Path $root 'scripts\setup-dsh-panel.mjs') --remove
  & $node (Join-Path $root 'scripts\setup-dsh-plugin.mjs') --remove
  & $node (Join-Path $root 'scripts\setup-dsh-mcp.mjs') --remove
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\uninstall-autostart.ps1')
  Write-Host ''
  Write-Host 'uninstalled. Restart DSH to drop the plugins; memd/tokens were left alone.'
  exit 0
}

# 1. build
if (-not $SkipBuild) {
  $tsc = Join-Path $root 'node_modules\typescript\bin\tsc'
  if (-not (Test-Path -LiteralPath $tsc)) { Fail "missing $tsc (run pnpm install first)" }
  Write-Host 'building...'
  & $node $tsc -b
  if ($LASTEXITCODE -ne 0) { Fail 'build failed' }
  $postbuild = Join-Path $root 'packages\adapter-qq\scripts\postbuild.mjs'
  if (Test-Path -LiteralPath $postbuild) { & $node $postbuild }
}

# 2. MCP block + root token (reuses an existing valid token)
Write-Host 'MCP server + root token...'
& $node (Join-Path $root 'scripts\setup-dsh-mcp.mjs') --with-token
if ($LASTEXITCODE -ne 0) { Fail 'setup-dsh-mcp failed' }

# 3. the two plugins we own
Write-Host 'ingest plugin...'
& $node (Join-Path $root 'scripts\setup-dsh-plugin.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'setup-dsh-plugin failed' }
Write-Host 'settings panel...'
& $node (Join-Path $root 'scripts\setup-dsh-panel.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'setup-dsh-panel failed' }

# 4. optional autostart (memd watchdog here, pet revive lives in its own project)
if ($WithAutostart) {
  Write-Host 'autostart (memd watchdog)...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install-autostart.ps1')
  $petTask = Join-Path (Split-Path $root -Parent) 'dsh-pet-configurable-llm\scripts\install-revive-task.ps1'
  if (Test-Path -LiteralPath $petTask) {
    Write-Host 'autostart (pet revive)...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $petTask
  }
  else { Write-Host 'pet revive task skipped (dsh-pet-configurable-llm not found)' }
}

# 5. optional semantic search
if ($Semantic) {
  Write-Host 'semantic: model + config + backfill...'
  & $node (Join-Path $root 'scripts\fetch-model.mjs')
  if ($LASTEXITCODE -ne 0) { Fail 'fetch-model failed' }
  & $node (Join-Path $root 'scripts\set-semantic.mjs') --on
  if ($LASTEXITCODE -ne 0) { Fail 'set-semantic failed' }
  if (Test-NetConnection 127.0.0.1 -Port 8787 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    & $node (Join-Path $root 'scripts\embed.mjs')
    if ($LASTEXITCODE -ne 0) { Write-Host 'embed failed (memd may need a restart to pick up semantic.enabled)' -ForegroundColor Yellow }
  }
  else { Write-Host 'memd is not running; start it, then run: node scripts\embed.mjs' -ForegroundColor Yellow }
}

# 6. doctor
Write-Host ''
& $node (Join-Path $root 'scripts\doctor.mjs')
$doctorExit = $LASTEXITCODE
Write-Host ''
if ($doctorExit -ne 0) { Write-Host 'doctor reported missing items (see above).' -ForegroundColor Yellow }
Write-Host 'done. Restart DSH Desktop to load the MCP server and both plugins.'
Write-Host 'verify later with: powershell -ExecutionPolicy Bypass -File scripts\setup-all.ps1 -Check'
exit $doctorExit
