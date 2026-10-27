<#
  qq-stack: bring up the QQ bridge stack after logon.

  Order: DSH -> SnowLuma -> hook -> memd -> pet -> bridge -> backup.

  Lives here (memory-hub\scripts) on purpose: this script orchestrates three
  services, so it belongs next to restart-stack.ps1 / post-upgrade.ps1.
  qq-bridge only owns its own start/stop (start-bridge.ps1, scripts\stop-bridge.ps1).

  Each step is skipped when it is already running, so the script is safe to
  run by hand as well. Everything is written to <qq-bridge>\logs\stack.log.

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

$root      = Split-Path -Parent $PSScriptRoot      # memory-hub
$stackRoot = Split-Path $root -Parent              # workspace root
$bridgeDir = Join-Path $stackRoot 'qq-bridge'
$petDir    = Join-Path $stackRoot 'dsh-pet-configurable-llm'
$logDir    = Join-Path $bridgeDir 'logs'
$logFile   = Join-Path $logDir 'stack.log'

# Port single source of truth: bridge consolePort and pet listen.port come
# from their own config.json. No bare 3100 / 8790 below.
$portsPs = Join-Path $bridgeDir 'scripts\ports.ps1'
if (Test-Path -LiteralPath $portsPs) { . $portsPs }
$bridgePort = Get-BridgeConsolePort -ConfigPath (Join-Path $bridgeDir 'config.json')
$petPort    = Get-PetPort -ConfigPath (Join-Path $petDir 'config.json')
$memdPort   = Get-MemdPort -ConfigPath (Join-Path $root 'config.json')

# Local path overrides live with qq-bridge (they point at SnowLuma / DSH installs).
$localPaths = Join-Path $bridgeDir 'local-paths.ps1'
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
    # A plain 401 is not enough: memd/pet and other loopback services also answer
    # 401 for unauthenticated requests. DSH's unauthenticated response carries a
    # fixed marker body, so require that too (same rule start-bridge.ps1 uses).
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

# Ports that belong to other services we start ourselves, never DSH.
$ReservedPorts = @(3000, 3001, $bridgePort, 5099, $memdPort, $petPort)

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
    if ($snowNode -and (Test-Path -LiteralPath $snowNode)) {
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
    else { Write-Log ("SnowLuma node.exe missing: " + $(if ($snowNode) { $snowNode } else { '(set local-paths.ps1 or SNOWLUMA_DIR)' })) }
}
else { Write-Log 'SnowLuma already running' }

# 2.5 Attach the SnowLuma hook to the bot account's QQ process.
$hookJs = Join-Path $bridgeDir 'snowluma-hook.mjs'
if ((Test-Path -LiteralPath $hookJs) -and (Test-Port 5099)) {
    Write-Log 'ensuring QQ hook on the bot account'
    & $snowNode $hookJs *>&1 | ForEach-Object { Write-Log ("hook: " + $_) }
    Write-Log ("hook exit: " + $LASTEXITCODE)
}

# 2.6 Memory service (memd). Best effort: the bridge degrades silently when it
#     is down, so a failure here must never stop the stack from coming up.
#     The login task (memd-watchdog) owns memd in v2; this is only a fallback.
$memoryStart = Join-Path $root 'scripts\start.ps1'
if (Test-Path -LiteralPath $memoryStart) {
    Write-Log 'starting memd (memory-hub)'
    # 不要用 `& powershell.exe ... | ForEach-Object`：管道句柄会被 memd 子进程继承，
    # start.ps1 明明已经退出，管道却一直开着等 memd 结束 —— 整栈启动就僵在这里
    # （2026-10-27 实测：服务全起来了，restart-stack 却卡了 5 分钟以上）。
    # 改成 -Wait + 重定向到文件，子进程拿不到管道。
    $memdOut = Join-Path $logDir 'memd-start.out.log'
    $memdErr = Join-Path $logDir 'memd-start.err.log'
    $memdProc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$memoryStart`"") `
        -WorkingDirectory $root -Wait -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $memdOut -RedirectStandardError $memdErr
    Get-Content -LiteralPath $memdOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Log ("memd: " + $_) }
    Get-Content -LiteralPath $memdErr -ErrorAction SilentlyContinue | ForEach-Object { Write-Log ("memd: " + $_) }
    # -Wait 之后还要显式 WaitForExit：PowerShell 5.1 里 ExitCode 可能还没刷新（读到空）。
    $memdProc.WaitForExit()
    Write-Log ("memd exit: " + $memdProc.ExitCode)
}
else { Write-Log "memory start script missing: $memoryStart" }

# 2.7 pet-brain. It only serves the DSH pet-chat preset, so its lifetime follows
#     DSH instead of a login task: started here right after DSH is known to be
#     up; pet exits by itself when DSH has been unreachable for 3 x 20s
#     (src/guard.mjs), so no orphan keeps holding its port.
#     Start/stop live with pet (dsh-pet-configurable-llm\scripts\).
$petStart = Join-Path $petDir 'scripts\start.ps1'
if ($null -ne $dshPort -and (Test-Path -LiteralPath $petStart)) {
    if (Test-Port $petPort) { Write-Log 'pet-brain already running' }
    else {
        Write-Log "starting pet-brain (DSH port $dshPort)"
        $env:DSH_WEB_URL = "http://127.0.0.1:$dshPort"
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$petStart`"") `
            -WorkingDirectory $petDir `
            -RedirectStandardOutput (Join-Path $logDir 'pet.out.log') `
            -RedirectStandardError (Join-Path $logDir 'pet.err.log') `
            -WindowStyle Hidden | Out-Null
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            if (Test-Port $petPort) { break }
        }
        if (Test-Port $petPort) { Write-Log "pet-brain is listening on $petPort" }
        else { Write-Log 'pet-brain did not come up; see logs\pet.err.log' }
    }
}
elseif ($null -eq $dshPort) { Write-Log 'pet-brain skipped: DSH not reachable' }
else { Write-Log "pet start script missing: $petStart" }

# 3. Bridge (its console listens on the configured consolePort)
$bridgeUp = Test-Port $bridgePort
if ($bridgeUp -and $null -ne $dshPort) {
    $desired = "http://127.0.0.1:$dshPort"
    $current = ''
    try {
        $cfg = Get-Content -LiteralPath (Join-Path $bridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $current = $cfg.dsh.baseUrl
    }
    catch { }
    if ($current -and $current -ne $desired) {
        Write-Log "bridge points at $current but DSH is on $desired; restarting it"
        $bridgeListenRe = "127\.0\.0\.1:$bridgePort\s"
        foreach ($line in (netstat -ano -p TCP)) {
            if ($line -match $bridgeListenRe -and $line -match 'LISTENING' -and $line -match '(\d+)\s*$') {
                & taskkill /PID $Matches[1] /F 2>$null | Out-Null
                break
            }
        }
        Start-Sleep -Seconds 2
        $bridgeUp = Test-Port $bridgePort
    }
}
if (-not $bridgeUp) {
    $ps = Join-Path $bridgeDir 'start-bridge.ps1'
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
$backupScript = Join-Path $stackRoot 'memories\90-tools\backup.ps1'
if (Test-Path -LiteralPath $backupScript) {
    Write-Log 'daily backup'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript *>&1 |
        ForEach-Object { Write-Log ("backup: " + $_) }
}
else { Write-Log "backup script missing: $backupScript" }

Write-Log '--- stack done ---'

# Final status for the caller (manual run or start-stack.bat). Port from config.
if (Test-Port $bridgePort) {
    Write-Host ("[OK] bridge console: http://127.0.0.1:{0}" -f $bridgePort)
} else {
    Write-Host ("[WARN] bridge console is not listening on {0}" -f $bridgePort)
    Write-Host '       check logs\stack.log'
}
