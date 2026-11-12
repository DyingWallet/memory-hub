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

# 读写都用无 BOM 的 UTF-8：PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM，而 DSH 0.2.2
# 的 settings/update 解析带 BOM 的 cordis.patch.yml 会回 settings/rejected: Unexpected
# scalar at node end（表现为 qq-mode 模式写不穿）。2026-11-12 实测并修复。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($patchFile, $utf8NoBom)
if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
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
  [System.IO.File]::WriteAllText($patchFile, $without.TrimEnd(), $utf8NoBom)
  Write-Host "已移除 sleep-consolidator 块。重启 DSH 生效。"
  exit 0
}

$preset = (Get-Content $presetFile -Raw -Encoding UTF8).TrimEnd()
$block = "`n$begin`n$preset`n$end`n"
[System.IO.File]::WriteAllText($patchFile, ($without.TrimEnd() + $block), $utf8NoBom)
Write-Host "已写入 $patchFile"
Write-Host "重启 DSH 后，node scripts\sleep-consolidate.mjs 才能建整理会话。"
