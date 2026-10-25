# 本机路径配置模板。
#
# 用法：复制成 local-paths.ps1（已被 .gitignore），把路径改成你自己机器上的位置。
# start-stack.ps1 启动时会 dot-source 这个文件；也可以用环境变量覆盖：
#   $env:SNOWLUMA_DIR = 'C:\path\to\SnowLuma'
#   $env:DSH_EXE      = 'C:\path\to\DeepSeek Harness.exe'
#
# 两个都是可选的：不配置时 start-stack.ps1 会跳过对应步骤（StartDsh 默认 true，
# 但找不到 DSH 可执行文件时会打日志并继续，不会中断）。

$snowDir = 'C:\path\to\SnowLuma'
$dshExe  = 'C:\path\to\DeepSeek Harness.exe'
