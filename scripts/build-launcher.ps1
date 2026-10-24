# Build the no-window launcher into ..\tools\bin\run-hidden.exe
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1 -Force
#
# The scheduled tasks call:
#   run-hidden.exe <node.exe> <script.mjs> [args...]
# It uses CreateProcess + CREATE_NO_WINDOW, so no console window appears and no
# "Open File - Security Warning" dialog can block the task (wscript's
# WScript.Shell.Run went through ShellExecute and did exactly that).
#
# Idempotent: skips the compile when the exe is newer than the source.
# Keep this file ASCII-only (PowerShell 5.1 reads BOM-less .ps1 as ANSI).
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'launcher\run-hidden.cs'
$outDir = Join-Path (Split-Path $root -Parent) 'tools\bin'
$out = Join-Path $outDir 'run-hidden.exe'

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) { throw 'csc.exe not found (needs .NET Framework 4.x)' }
if (-not (Test-Path -LiteralPath $source)) { throw "missing source: $source" }

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$fresh = (Test-Path -LiteralPath $out) -and ((Get-Item $out).LastWriteTime -gt (Get-Item $source).LastWriteTime)
if ($fresh -and -not $Force) {
  Write-Host "up to date: $out"
  exit 0
}

& $csc /nologo /target:winexe /optimize+ "/out:$out" $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $out)) { throw "csc reported success but $out is missing" }

Write-Host "built: $out"
Write-Host "verify: node scripts\doctor.mjs should not report any wscript-hung task"
