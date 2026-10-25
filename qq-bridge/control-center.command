#!/bin/zsh
# qq-bridge 控制中心（macOS）：双击在「终端」里打开，和 Windows 的 control-center.bat 对应。
# 不会自己启动桥接、接口平台或 NapCat —— 用页面上的按钮。关掉这个终端窗口 = 退出控制中心及其启动的进程。
#
# 为什么要从「终端」启动：NapCat 的配置在 QQ 的沙盒容器里（~/Library/Containers/com.tencent.qq），
# macOS 会把读取它算在「启动控制中心的程序」头上并询问「访问其他 App 的数据」。从终端启动只需给终端授权一次。
cd "${0:A:h}" || exit 1
# 双击启动的终端不一定加载了 Homebrew 的 PATH
for p in /opt/homebrew/bin /opt/homebrew/opt/node@22/bin /usr/local/bin; do [[ -d $p ]] && PATH="$p:$PATH"; done
export PATH
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[qq-bridge] 没有找到 Node.js。请先安装 Node.js 22（例如 brew install node@22），再重新双击本文件。"
  echo
  read -k1 "?按任意键关闭…"
  exit 1
fi
# 第一次运行：顺手生成无窗口启动 App（同 npm run mac-app），以后双击它就不会再有终端窗口。
# 生成失败不影响这次启动；不想自动生成时设 QQ_BRIDGE_NO_MAC_APP=1。
APP="QQ Bridge 控制中心.app"
if [[ ! -d "$APP" && -z "$QQ_BRIDGE_NO_MAC_APP" ]]; then
  echo "[qq-bridge] 第一次运行：正在生成无窗口启动 App「$APP」…"
  if node scripts/build-mac-app.mjs >/dev/null 2>&1; then
    echo "[qq-bridge] 已生成，并在访达里选中了它。以后直接双击「$APP」即可（没有终端窗口）；这次仍在终端里运行。"
    open -R "$APP" 2>/dev/null
  else
    echo "[qq-bridge] 没能生成 App（稍后可以手动运行 npm run mac-app），这次照常在终端里启动。"
  fi
  echo
fi
node src/launcher/control-center.mjs "$@"
code=$?
if (( code != 0 )); then read -k1 "?控制中心异常退出（$code），按任意键关闭…"; fi
exit $code
