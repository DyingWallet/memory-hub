# 把 sleep-consolidator preset 接入 DSH profile。
# 必须在**普通 PowerShell 窗口**里跑（~/.dsh 对沙箱只读），跑完重启 DSH。
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-sleep-preset.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-sleep-preset.ps1 -Remove
param(
  [string]$Profile = 'desktop',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$patchFile = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
$presetFile = Join-Path $root 'preset\sleep-consolidator.patch.yml'
$begin = '# === sleep-consolidator BEGIN ==='
$end = '# === sleep-consolidator END ==='

if (-not (Test-Path $patchFile)) { throw "找不到 profile patch：$patchFile" }
if (-not $Remove -and -not (Test-Path $presetFile)) { throw "找不到 preset：$presetFile" }

$text = Get-Content $patchFile -Raw -Encoding UTF8
$without = $text
$start = $text.IndexOf($begin)
if ($start -ge 0) {
  $stop = $text.IndexOf($end, $start)
  if ($stop -lt 0) { throw 'profile 里的 sleep-consolidator 块不完整（缺 END 标记），先手工修' }
  $without = $text.Substring(0, $start) + $text.Substring($stop + $end.Length)
}

$stamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
Copy-Item $patchFile "$patchFile.bak-sleep-$stamp" -Force

if ($Remove) {
  Set-Content -Path $patchFile -Value $without.TrimEnd() -Encoding UTF8
  Write-Host "已移除 sleep-consolidator 块。重启 DSH 生效。"
  exit 0
}

$preset = (Get-Content $presetFile -Raw -Encoding UTF8).TrimEnd()
$block = "`n$begin`n$preset`n$end`n"
Set-Content -Path $patchFile -Value ($without.TrimEnd() + $block) -Encoding UTF8
Write-Host "已写入 $patchFile"
Write-Host "重启 DSH 后，node scripts\sleep-consolidate.mjs 才能建整理会话。"
