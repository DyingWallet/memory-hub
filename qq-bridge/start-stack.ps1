<#
  qq-stack: bring up the QQ bridge stack after logon.

  Order matters:
    1. DeepSeek Harness (optional) - the bridge needs its Web API
    2. SnowLuma                     - OneBot gateway on 3001
    3. qq-bridge                    - connects SnowLuma <-> DSH

  Each step is skipped when it is already running, so the script is safe to
  run by hand as well. Everything is written to logs\stack.log.

  Port detection: the desktop app picks a random loopback port on every start,
  and orphaned runtimes from earlier restarts may still answer 401 on old
  ports. Therefore:
    - DSH_WEB_URL wins when the harness exported it;
    - otherwise we snapshot the 401 ports before starting DSH and afterwards
      pick the port that appeared;
    - otherwise we fall back to the port whose process started last.
#>
[CmdletBinding()]
param(
    [bool]$StartDsh = $true,
    [int]$WaitSeconds = 180
)

$ErrorActionPreference = 'SilentlyContinue'

$root      = $PSScriptRoot
$logDir    = Join-Path $root 'logs'
$logFile   = Join-Path $logDir 'stack.log'
# 本机路径优先环境变量；也可以放在同目录的 local-paths.ps1（已 gitignore）。
# 仓库里不写死任何绝对路径，别人 clone 下来只要设好环境变量就能跑。
$localPaths = Join-Path $root 'local-paths.ps1'
if (Test-Path -LiteralPath $localPaths) { . $localPaths }
$snowDir   = if ($snowDir) { $snowDir } elseif ($env:SNOWLUMA_DIR) { $env:SNOWLUMA_DIR } else { '' }
$snowNode  = if ($snowDir) { Join-Path $snowDir 'node.exe' } else { '' }
$dshExe    = if ($dshExe) { $dshExe } elseif ($env:DSH_EXE) { $env:DSH_EXE } else { '' }

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$Text) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $task = $c.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait(700)) { $c.Close(); return $false }
        $ok = $c.Connected
        $c.Close()
        return $ok
    }
    catch { return $false }
}

function Test-DshPort([int]$Port) {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $false
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return $false }
        return ([int]$resp.StatusCode -eq 401)
    }
}

# Ports that belong to other services we start ourselves, never DSH.
$ReservedPorts = @(3000, 3001, 3100, 5099)

function Get-DshPorts {
    $result = @()
    foreach ($line in (netstat -ano -p TCP)) {
        if ($line -notmatch 'LISTENING') { continue }
        if ($line -notmatch '127\.0\.0\.1:(\d+)\s+\S+\s+\S+\s+(\d+)\s*$') { continue }
        $port = [int]$Matches[1]
        $procId = [int]$Matches[2]
        if ($ReservedPorts -contains $port) { continue }
        if (-not (Test-DshPort $port)) { continue }
        $start = [datetime]::MaxValue
        try { $start = (Get-Process -Id $procId -ErrorAction Stop).StartTime } catch { }
        $result += [pscustomobject]@{ Port = $port; Pid = $procId; Start = $start }
    }
    return $result
}

function Select-Newest($items) {
    if (-not $items -or $items.Count -eq 0) { return $null }
    return ($items | Sort-Object Start -Descending | Select-Object -First 1).Port
}

Write-Log '--- stack start ---'

# 0. Prefer the harness-exported URL (works when started from inside DSH).
$dshPort = $null
if ($env:DSH_WEB_URL) {
    try {
        $u = [Uri]$env:DSH_WEB_URL
        if ($u.IsLoopback -and (Test-DshPort $u.Port)) { $dshPort = $u.Port }
    }
    catch { }
}

# 1. DSH
if ($null -eq $dshPort) {
    $before = @(Get-DshPorts)
    if ($before.Count -gt 0) {
        $dshPort = Select-Newest $before
        Write-Log 'DSH already running; reusing the newest runtime'
    }
    elseif ($StartDsh -and (Test-Path -LiteralPath $dshExe)) {
        Write-Log 'starting DeepSeek Harness'
        # Redirect as well: a console-attached launcher could block Start-Process.
        Start-Process -FilePath $dshExe `
            -WorkingDirectory (Split-Path $dshExe) `
            -RedirectStandardOutput (Join-Path $logDir 'dsh.out.log') `
            -RedirectStandardError (Join-Path $logDir 'dsh.err.log') | Out-Null
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            $after = @(Get-DshPorts)
            $fresh = @($after | Where-Object { $before.Port -notcontains $_.Port })
            if ($fresh.Count -gt 0) { $dshPort = Select-Newest $fresh; break }
        }
    }
    elseif (-not (Test-Path -LiteralPath $dshExe)) {
        Write-Log "DSH executable missing: $dshExe"
    }
}
if ($null -ne $dshPort) { Write-Log "DSH web port: $dshPort" }
else { Write-Log 'DSH not reachable; the bridge will queue messages until it is' }

# 2. SnowLuma
if (-not (Test-Port 5099)) {
    if (Test-Path -LiteralPath $snowNode) {
        Write-Log 'starting SnowLuma'
        # Redirecting stdout/stderr is required: without it Start-Process blocks on
        # this console app and the whole stack script never returns.
        Start-Process -FilePath $snowNode `
            -ArgumentList 'index.mjs' `
            -WorkingDirectory $snowDir `
            -RedirectStandardOutput (Join-Path $logDir 'snowluma.out.log') `
            -RedirectStandardError (Join-Path $logDir 'snowluma.err.log') `
            -WindowStyle Hidden | Out-Null
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            if (Test-Port 5099) { break }
        }
    }
    else { Write-Log "SnowLuma node.exe missing: $snowNode" }
}
else { Write-Log 'SnowLuma already running' }

# 2.5 Attach the SnowLuma hook to the bot account's QQ process.
$hookJs = Join-Path $root 'snowluma-hook.mjs'
if ((Test-Path -LiteralPath $hookJs) -and (Test-Port 5099)) {
    Write-Log 'ensuring QQ hook on the bot account'
    & $snowNode $hookJs *>&1 | ForEach-Object { Write-Log ("hook: " + $_) }
    Write-Log ("hook exit: " + $LASTEXITCODE)
}

# 2.6 Memory service (memd). Best effort: the bridge degrades silently when it
#     is down, so a failure here must never stop the stack from coming up.
#     The login task (memd-autostart) owns memd in v2; this is only a fallback,
#     and start.ps1 exits 0 when /v1/health already answers.
$memoryStart = Join-Path (Split-Path $root -Parent) 'memory-hub\scripts\start.ps1'
if (Test-Path -LiteralPath $memoryStart) {
    Write-Log 'starting memd (memory-hub)'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $memoryStart *>&1 |
        ForEach-Object { Write-Log ("memd: " + $_) }
    Write-Log ("memd exit: " + $LASTEXITCODE)
}
else { Write-Log "memory start script missing: $memoryStart" }

# 2.7 pet-brain (桌宠后端, 8790). It only serves the DSH pet-chat preset, so its
#     lifetime follows DSH instead of a login task (v2 autostart plan B):
#       - started here, right after DSH is known to be up;
#       - pet exits by itself when DSH has been unreachable for 3 x 20s
#         (src/guard.mjs), so no orphan keeps holding 8790.
#     DSH_WEB_URL is exported for the child so pet does not have to discover the
#     random desktop port on its first turn.
$petRoot  = Join-Path (Split-Path $root -Parent) 'dsh-pet-configurable-llm'
$petStart = Join-Path $petRoot 'scripts\start.ps1'
if ($null -ne $dshPort -and (Test-Path -LiteralPath $petStart)) {
    if (Test-Port 8790) { Write-Log 'pet-brain already running' }
    else {
        Write-Log "starting pet-brain (DSH port $dshPort)"
        $env:DSH_WEB_URL = "http://127.0.0.1:$dshPort"
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$petStart`"") `
            -WorkingDirectory $petRoot `
            -RedirectStandardOutput (Join-Path $logDir 'pet.out.log') `
            -RedirectStandardError (Join-Path $logDir 'pet.err.log') `
            -WindowStyle Hidden | Out-Null
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            if (Test-Port 8790) { break }
        }
        if (Test-Port 8790) { Write-Log 'pet-brain is listening on 8790' }
        else { Write-Log 'pet-brain did not come up; see logs\pet.err.log' }
    }
}
elseif ($null -eq $dshPort) { Write-Log 'pet-brain skipped: DSH not reachable' }
else { Write-Log "pet start script missing: $petStart" }

# 3. Bridge (its console listens on 3100)
$bridgeUp = Test-Port 3100
if ($bridgeUp -and $null -ne $dshPort) {
    $desired = "http://127.0.0.1:$dshPort"
    $current = ''
    try {
        $cfg = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $current = $cfg.dsh.baseUrl
    }
    catch { }
    if ($current -and $current -ne $desired) {
        Write-Log "bridge points at $current but DSH is on $desired; restarting it"
        foreach ($line in (netstat -ano -p TCP)) {
            if ($line -match '127\.0\.0\.1:3100\s' -and $line -match 'LISTENING' -and $line -match '(\d+)\s*$') {
                & taskkill /PID $Matches[1] /F 2>$null | Out-Null
                break
            }
        }
        Start-Sleep -Seconds 2
        $bridgeUp = Test-Port 3100
    }
}
if (-not $bridgeUp) {
    $ps = Join-Path $root 'start-bridge.ps1'
    if (Test-Path -LiteralPath $ps) {
        Write-Log 'starting qq-bridge'
        $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$ps`"")
        if ($null -ne $dshPort) { $args += @('-Port', "$dshPort") }
        Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null
    }
    else { Write-Log "start-bridge.ps1 missing: $ps" }
}
else { Write-Log 'qq-bridge already running' }

# 4. Daily backup of state + memories. Best effort: a failure here must never
#    stop the stack from coming up. The script itself skips a second run on the
#    same day, so starting the stack twice costs nothing.
$backupScript = Join-Path (Split-Path $root -Parent) 'memories\90-tools\backup.ps1'
if (Test-Path -LiteralPath $backupScript) {
    Write-Log 'daily backup'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript *>&1 |
        ForEach-Object { Write-Log ("backup: " + $_) }
}
else { Write-Log "backup script missing: $backupScript" }

Write-Log '--- stack done ---'
