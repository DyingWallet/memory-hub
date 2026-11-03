# Repair the "DeepSeek Messages request failed (400)" loop caused by lone
# surrogates (half-cut emoji) in DSH session files.
#
# Why this exists (2026-11-04):
#   The bridge cut text by UTF-16 code units, so an emoji could be split in half.
#   The orphan half (e.g. U+D83C) went into a DSH session. DeepSeek's Messages
#   parser rejects the whole request with HTTP 400 and a PLAIN-TEXT body, which
#   DSH can only render as "request failed (400)"; 400 is not retried, so every
#   wake fails forever. Fixing the writer stops new corruption, but the bad
#   bytes already stored in the session keep breaking every request, so they
#   must be rewritten out of the file.
#
# Scope: this script STOPS the bridge and DSH (required: DSH owns the session
# files and would overwrite the rewrite), then repairs the files. It does NOT
# start anything back up -- starting DSH and the stack is the operator's job.
#
# Usage (run from a NORMAL PowerShell window, NOT from inside DSH):
#   powershell -ExecutionPolicy Bypass -File scripts\fix-qq-400-recovery.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\fix-qq-400-recovery.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\fix-qq-400-recovery.ps1 -Session c39b8891
#
# Notes:
#   - Every session file is backed up under memory-hub\backups\sessions\<stamp>\.
#     The fixer refuses to write when JSON validity or line counts would change
#     (except a trailing half-line, which needs -TrimTail to be dropped).
#   - QQ messages received while the bridge is down are queued by SnowLuma and
#     replayed on the next start.
#   - If the bridge had already retired the bad session (it does that on its own
#     after repeated empty turns), repairing the file only removes the landmine;
#     the QQ thread continues in the NEW session, so its context does not return.
#   - When this finishes, start things yourself:
#       powershell -ExecutionPolicy Bypass -File scripts\start-stack.ps1
[CmdletBinding()]
param(
    [string]$Session = '',
    [switch]$DryRun,
    [switch]$TrimTail,
    [switch]$Force,
    [int]$DshWaitSeconds = 60,
    [int]$SettleSeconds = 20
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $PSScriptRoot        # memory-hub
$stackRoot = Split-Path $root -Parent                # workspace root
$bridgeDir = Join-Path $stackRoot 'qq-bridge'
$node      = Join-Path $stackRoot 'tools\node\node.exe'
$fixer     = Join-Path $PSScriptRoot 'fix-session-surrogates.mjs'
$backupDir = Join-Path $root 'backups\sessions'
$lockFile  = Join-Path $bridgeDir 'state\bridge.lock'

function Write-Step([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Write-Warn([string]$Text) { Write-Host $Text -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $node))  { throw "node.exe not found: $node" }
if (-not (Test-Path -LiteralPath $fixer)) { throw "fixer not found: $fixer" }

# --- preflight -------------------------------------------------------------
$nodeVersion = & $node --version
if ($nodeVersion -notmatch '^v(\d+)\.(\d+)' -or ([int]$Matches[1] -lt 22) -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 15)) {
    throw "node $nodeVersion has no zlib zstd support (need >= 22.15): $node"
}

# Running from inside DSH kills the window we are talking through: the script
# stops DSH, which takes this process with it. Detect it instead of half-running.
# Dry runs are read-only and allowed.
if (-not $Force -and -not $DryRun) {
    $inDsh = $false
    if ($env:DSH_WEB_URL) { $inDsh = $true }
    try {
        $cursor = $PID
        for ($i = 0; $i -lt 6 -and $cursor -and -not $inDsh; $i++) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $cursor" -ErrorAction Stop
            if (-not $proc) { break }
            $parentId = [int]$proc.ParentProcessId
            if ($parentId -le 0) { break }
            $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
            if (-not $parent) { break }
            if ($parent.ProcessName -eq 'DeepSeek Harness') { $inDsh = $true; break }
            $cursor = $parentId
        }
    } catch {
        # CIM denied (sandbox). The DSH_WEB_URL check above still covers the
        # common case; do not block on a missing capability.
    }
    if ($inDsh) {
        throw 'This is running inside DSH. Open a separate PowerShell window (Win+X -> Terminal) and run it there; stopping DSH would kill this process too. Use -Force to override.'
    }
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$sessionsRoot = Join-Path $dshHome 'sessions'
if (-not (Test-Path -LiteralPath $sessionsRoot)) { throw "sessions dir not found: $sessionsRoot" }

$targets = @()
if ($Session) {
    $hits = @(Get-ChildItem -Path $sessionsRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'session.v*.jsonl*' -and $_.FullName -like "*$Session*" })
    if ($hits.Count -eq 0) { throw "session not found under $sessionsRoot : $Session" }
    if ($hits.Count -gt 1) {
        Write-Host 'Multiple sessions match; pass a longer fragment:'
        $hits | ForEach-Object { Write-Host ("  " + (Split-Path -Parent $_.FullName | Split-Path -Leaf)) }
        throw 'ambiguous -Session'
    }
    $targets = @($hits[0].FullName)
}

$fixerArgs = @($fixer)
if ($targets.Count -gt 0) { $fixerArgs += $targets }
$fixerArgs += @('--backup-dir', $backupDir)
if ($TrimTail) { $fixerArgs += '--trim-tail' }

Write-Step '=== qq 400 repair ==='

# --- dry run only ----------------------------------------------------------
if ($DryRun) {
    & $node @fixerArgs
    Write-Warn 'dry run finished (nothing written)'
    exit 0
}

# DSH must be closed; ask once so a typo in a shortcut cannot kill the session.
if (-not $Force) {
    Write-Host 'This will stop the QQ bridge and CLOSE the DeepSeek Harness window,'
    Write-Host 'then rewrite session files. It will NOT start them again -- you do that.'
    $answer = ''
    try { $answer = Read-Host 'Continue? [y/N]' } catch { $answer = '' }
    if ($answer -notmatch '^[Yy]') {
        Write-Warn 'aborted by user (nothing was changed)'
        exit 1
    }
}

$state = @{
    BridgeStopped = $false
    DshStopped    = $false
    FixerExit     = -1
}

# --- write-capability probe (BEFORE stopping anything) ---------------------
# Reading, decompressing and validating all succeed inside the DSH sandbox or a
# low-integrity terminal; only the WRITE is refused (EPERM). Measured
# 2026-11-04: the run stopped DSH first and only then hit EPERM, leaving the
# desktop closed for nothing. Probe the exact capability this script needs up
# front, and refuse before touching any service.
$probe = Join-Path $dshHome ('.write-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
$writable = $true
$probeError = ''
try {
    [System.IO.File]::WriteAllText($probe, 'probe')
} catch {
    $writable = $false
    $probeError = $_.Exception.GetType().Name
}
if ($writable) {
    try { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue } catch { }
}
if (-not $writable) {
    Write-Warn ''
    Write-Warn ("Cannot create files under {0} ({1})." -f $dshHome, $probeError)
    Write-Warn 'Reading and scanning work, but writing does not -- that is a permission problem,'
    Write-Warn 'not a repair problem. Nothing was stopped and nothing was changed.'
    Write-Warn 'Open a plain system PowerShell (Win+X -> Terminal, or search "PowerShell" in Start),'
    Write-Warn 'not a terminal started from inside DSH, and run this script there.'
    exit 1
}

try {
    # --- 1. stop the bridge ------------------------------------------------
    Write-Step '--- 1/4 stopping qq-bridge ---'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bridgeDir 'scripts\stop-bridge.ps1')

    # stop-bridge.ps1 only looks at the console port listener. Measured
    # 2026-11-04: it can report "nothing listening" while the process is still
    # alive, which would let it keep appending to the very file we rewrite.
    # Fall back to the pid recorded in state\bridge.lock.
    if (Test-Path -LiteralPath $lockFile) {
        $lockPid = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction SilentlyContinue)
        if ($lockPid -match '^\s*\d+\s*$') {
            $p = Get-Process -Id ([int]$lockPid.Trim()) -ErrorAction SilentlyContinue
            if ($p) {
                Write-Warn "bridge still alive (pid $($p.Id)); killing by bridge.lock"
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                $wait = (Get-Date).AddSeconds(10)
                while ((Get-Date) -lt $wait -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }
            }
        }
    }
    Start-Sleep -Seconds 2
    if (Test-Path -LiteralPath $lockFile) {
        $lockPid = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($lockPid -match '^\d+$' -and (Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue)) {
            throw "qq-bridge is still running (pid $lockPid). Stop it manually, then rerun."
        }
    }
    $state.BridgeStopped = $true

    # --- 2. stop DSH -------------------------------------------------------
    Write-Step '--- 2/4 stopping DeepSeek Harness (the desktop window closes) ---'
    $dsh = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($dsh.Count -gt 0) {
        $dsh | Stop-Process -Force -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds($DshWaitSeconds)
        while ((Get-Date) -lt $deadline) {
            if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
            throw 'DeepSeek Harness did not exit (running elevated?). Close it manually, then rerun.'
        }
    }
    $state.DshStopped = $true
    Write-Host 'DSH stopped'

    # DSH spawns a child named 'electron' that Stop-Process above does not
    # match. If it survives, it can keep the session files open and every
    # rewrite fails with EPERM (measured 2026-11-04). Warn instead of guessing.
    $leftover = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match 'DeepSeek|electron|Harness' })
    if ($leftover.Count -gt 0) {
        Write-Warn 'These processes are still running and may hold session files open:'
        $leftover | ForEach-Object { Write-Warn ("  {0} (pid {1})" -f $_.ProcessName, $_.Id) }
        Write-Warn 'If the rewrite below fails with EPERM, close them and rerun this script.'
    }

    # --- 2b. wait until the session files stop changing --------------------
    # A forced kill can leave a few buffered appends in flight; rewriting while
    # something still writes would lose those bytes silently.
    $checkFiles = $targets
    if ($checkFiles.Count -eq 0) {
        $checkFiles = @(Get-ChildItem -Path $sessionsRoot -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'session.v*.jsonl*' } |
            ForEach-Object { $_.FullName })
    }
    if ($checkFiles.Count -gt 0) {
        $settleDeadline = (Get-Date).AddSeconds($SettleSeconds)
        $prev = @{}
        foreach ($f in $checkFiles) {
            $item = Get-Item -LiteralPath $f -ErrorAction SilentlyContinue
            if ($item) { $prev[$f] = "$($item.Length)/$($item.LastWriteTimeUtc.Ticks)" }
        }
        while ((Get-Date) -lt $settleDeadline) {
            Start-Sleep -Milliseconds 700
            $changed = $false
            foreach ($f in $checkFiles) {
                $item = Get-Item -LiteralPath $f -ErrorAction SilentlyContinue
                $sig = if ($item) { "$($item.Length)/$($item.LastWriteTimeUtc.Ticks)" } else { 'gone' }
                if ($prev[$f] -ne $sig) { $changed = $true; $prev[$f] = $sig }
            }
            if (-not $changed) { break }
        }
    }

    # --- 2c. wait until the files can be opened for writing ----------------
    # mtime/size being stable does not mean the handle is gone. A forced kill
    # leaves the OS to release handles with a delay, and any survivor keeps the
    # file locked -- which is exactly the EPERM seen on 2026-11-04.
    $notReady = @()
    foreach ($f in $checkFiles) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        $locked = $true
        $lockDeadline = (Get-Date).AddSeconds($SettleSeconds)
        while ((Get-Date) -lt $lockDeadline) {
            try {
                $fs = [System.IO.File]::Open($f, 'Open', 'ReadWrite', 'None')
                $fs.Close()
                $locked = $false
                break
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if ($locked) { $notReady += $f }
    }
    if ($notReady.Count -gt 0) {
        Write-Warn ("{0} session file(s) are still locked after {1}s:" -f $notReady.Count, $SettleSeconds)
        $notReady | ForEach-Object { Write-Warn ("  " + (Split-Path -Parent $_ | Split-Path -Leaf)) }
        Write-Warn 'The fixer will retry, but if it fails: close any remaining DeepSeek/electron'
        Write-Warn 'processes, then rerun this script.'
    }

    # --- 3. rewrite the sessions ------------------------------------------
    Write-Step '--- 3/4 fixing lone surrogates in session files ---'
    & $node @fixerArgs --apply
    $fixerExit = $LASTEXITCODE
    $state.FixerExit = $fixerExit
    if ($fixerExit -eq 2) {
        throw 'session fixer refused to write (see messages above). Nothing was modified.'
    }
    if ($fixerExit -eq 4) {
        Write-Warn ''
        Write-Warn 'Some session files could not be written. Processes still holding them:'
        Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -match 'DeepSeek|electron|Harness' } |
            ForEach-Object { Write-Warn ("  {0} (pid {1})" -f $_.ProcessName, $_.Id) }
        throw 'session fixer could not write every file (see [fail] lines above).'
    }
    if ($fixerExit -ne 0) { throw "session fixer failed with exit code $fixerExit" }
}
catch {
    Write-Warn ''
    Write-Warn ("FAILED: " + $_.Exception.Message)
    Write-Warn ("state: bridge stopped={0}, DSH stopped={1}, fixer exit={2}" -f $state.BridgeStopped, $state.DshStopped, $state.FixerExit)
    Write-Warn 'Nothing will be started automatically. Bring things back yourself when ready:'
    Write-Warn ("  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\start-stack.ps1`"")
    exit 1
}

Write-Host ''
Write-Host '=== repair finished ===' -ForegroundColor Green
Write-Host ("backups: {0}" -f $backupDir)
Write-Host ''
Write-Host 'DSH and the QQ bridge are still stopped. Start them when you are ready:'
Write-Host ("  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\start-stack.ps1`"")
Write-Host ''
Write-Host 'A session that the bridge already retired will not come back with its old'
Write-Host 'context even after the rewrite; the QQ thread continues in the new session.'
