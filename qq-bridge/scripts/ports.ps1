<#
  Single source of truth for port resolution (PowerShell side).

  Any script that needs the bridge console port / memd port / pet port must
  dot-source this file instead of hardcoding 3100 / 8787 / 8790. Changing a
  config.json and forgetting a script is exactly how post-upgrade.ps1 once
  reported a false FAIL against a port nobody was listening on.

  Sources (each service owns its own config.json):
    qq-bridge\config.json                  -> consolePort   (default 3100)
    memory-hub\config.json                 -> port          (default 8787)
    dsh-pet-configurable-llm\config.json   -> listen.port   (default 8790)

  Usage:
    . (Join-Path $PSScriptRoot 'scripts\ports.ps1')   # this file lives in qq-bridge\scripts\
    $bridgePort = Get-BridgeConsolePort
    $petPort    = Get-PetPort -ConfigPath "$petRoot\config.json"

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less .ps1
  as ANSI, so non-ASCII comments can swallow the following line.
#>

# When dot-sourced, this file runs at top level and $PSScriptRoot is scripts\.
$script:BridgePortsRoot = $PSScriptRoot

function Read-PortConfig {
  param([string]$Path)
  try {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ($raw -and $raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

function Resolve-ServicePort {
  param($Config, [string]$Property, [int]$Default)

  if ($null -eq $Config) { return $Default }
  $n = 0
  if ([int]::TryParse([string]$Config.$Property, [ref]$n) -and $n -ge 1 -and $n -le 65535) { return $n }
  return $Default
}

function Get-ServicePort {
  param([string]$ConfigPath, [string]$Property = 'port', [int]$Default = 0)
  return (Resolve-ServicePort (Read-PortConfig $ConfigPath) $Property $Default)
}

function Get-BridgeConsolePort {
  param([string]$ConfigPath)
  if (-not $ConfigPath) { $ConfigPath = Join-Path $script:BridgePortsRoot '..\config.json' }
  return (Get-ServicePort -ConfigPath $ConfigPath -Property 'consolePort' -Default 3100)
}

function Get-MemdPort {
  param([string]$ConfigPath)
  if (-not $ConfigPath) { $ConfigPath = Join-Path $script:BridgePortsRoot '..\..\memory-hub\config.json' }
  return (Get-ServicePort -ConfigPath $ConfigPath -Property 'port' -Default 8787)
}

function Get-PetPort {
  param([string]$ConfigPath)
  if (-not $ConfigPath) { $ConfigPath = Join-Path $script:BridgePortsRoot '..\..\dsh-pet-configurable-llm\config.json' }
  $cfg = Read-PortConfig $ConfigPath
  if ($null -eq $cfg) { return 8790 }
  $n = 0
  if ([int]::TryParse([string]$cfg.listen.port, [ref]$n) -and $n -ge 1 -and $n -le 65535) { return $n }
  return 8790
}
