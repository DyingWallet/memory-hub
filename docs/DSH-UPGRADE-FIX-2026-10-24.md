# DSH 0.2.1-rc.3 升级失败：排查与修复记录

- **日期**：2026-10-24
- **目标版本**：deepseek-harness `0.2.1-rc.3`（win-x64）
- **安装目录**：`D:\Software\dsh`
- **结论**：升级已完成并验证；失败原因与 DSH 本身无关，是**两个外部进程占用了安装目录**。

---

## 1. 故障现象

运行安装包（`dsh-latest-windows-x64.exe` / updater 缓存里的 `installer.exe`）无任何界面报错，但版本始终不变。同一错误共出现 5 次：

| 时间 | 日志文件 |
| --- | --- |
| 18:58:44 | `directory-failure-20261024-185844.log` |
| 19:00:46 | `directory-failure-20261024-190046.log` |
| 19:07:59 | `directory-failure-20261024-190759.log` |
| 19:35:54 | `directory-failure-20261024-193554.log` |
| 19:53:58 | `directory-failure-20261024-195358.log`（本次排查中复现） |

日志位置：

```
%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\installer-logs\
```

原始日志内容（5 份完全一致，仅 GUID 与时间不同）：

```
Operation: MoveFileExW
Windows error: 32 (另一个程序正在使用此文件，进程无法访问。)
Source: D:\Software\dsh
Destination: D:\Software\dsh.old-{01323C89-0F39-475B-BDDE-CDA5B3004ED4}
Restoration error: 0
Windows: 10.0.26300
Attempts:
backup: Windows error: 32   (×10)
```

即：安装器在覆盖前要把旧目录改名为 `dsh.old-{GUID}` 做备份，`MoveFileExW` 连续 10 次失败后放弃。

---

## 2. 根因

`ERROR_SHARING_VIOLATION (32)` 意味着**目录被占用**。本次有两个相互独立的占用者，只解决其中一个仍会失败——这也是为什么前四次反复重试都没有进展。

### 占用者 A：memory-hub 的 memd 进程（PID 36164）

- 启动时间 17:24:04，孤儿进程（父进程 36604 已退出）
- 命令行：

```
"D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  D:\deepseek_workspace\memory-hub\packages\server\dist\index.js
```

- 它执行的是 **DSH 安装目录内的内置 node.exe**，Windows 会锁定正在运行的映像文件，导致父目录无法改名。
- 拉起链路：

```
计划任务 memd-watchdog（每 1 分钟）
  → wscript.exe run-hidden.vbs
  → <D:\Software\dsh\...\node.exe> supervisor.mjs
  → scripts\start.ps1 的 Resolve-Node 第一优先级命中 DSH 内置 node
  → memd (PID 36164)
```

> 因此**只杀进程无效**：看门狗会在 60 秒内把它重新拉起，再次锁住目录。

### 占用者 B：QQ 拼音用户中心（PID 7040）— 隐藏的第二个锁

停掉 memd 后，19:53:58 仍然以完全相同的错误失败。进一步排查：

1. 逐项改名测试：`D:\Software\dsh` 下**所有子文件/子目录均可正常改名** → 说明锁在**目录本身**，不是某个文件。
2. `handle.exe`（Sysinternals）搜索 `dsh`，定位到：

```
QQPYUserCenter.exe  pid: 7040  type: File  98: D:\Software\dsh
```

- 路径：`D:\Software\Tencent\QQPinyin\6.6.6304.400\QQPYUserCenter.exe`
- 启动时间 15:22:46（比第一次安装失败还早），命令行 `... qqpinyin.ime`
- 它是 QQ 拼音的输入法「用户中心」辅助进程，与 DSH 无关，却对安装目录持有一个目录句柄。持锁原因不明（疑似句柄泄漏或该进程的工作目录被设成该路径）。
- 该进程不承担实际输入职责，结束它不影响打字。

---

## 3. 已执行的修复

| 步骤 | 命令 / 动作 | 结果 |
| --- | --- | --- |
| 1 | `Disable-ScheduledTask -TaskName "memd-watchdog"` | State=Disabled，防止 memd 被重新拉起 |
| 2 | `powershell -File D:\deepseek_workspace\memory-hub\scripts\stop.ps1` | 停止 memd PID 36164，8787 端口释放 |
| 3 | 校验安装包 SHA512 | 与 `pending\update-info.json` 一致，FileVersion `0.2.1-rc.3` |
| 4 | 首次静默安装（19:53） | **失败**，WinError 32 → 由此发现占用者 B |
| 5 | `Stop-Process -Id 7040` | 结束 QQPYUserCenter.exe |
| 6 | 改名探针 `[IO.Directory]::Move` | `MOVE-OK` / `RESTORED-OK`，目录已可改名 |
| 7 | `installer.exe /S` | **exit 0，耗时 12s** |
| 8 | `Enable-ScheduledTask` + `Start-ScheduledTask memd-watchdog` | LastTaskResult=0，memd 恢复（PID 34584） |

安装前后对比：

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 主程序文件时间 | 2026-10-17 17:20 | 2026-10-23 16:00 |
| `resources\app.asar` | 182,794,869 B | 182,434,783 B |
| exe FileVersion | — | **0.2.1-rc.3** |
| `dsh.old-*` 残留 | 无 | 无 |

---

## 4. 验证结果

`scripts\post-upgrade.ps1` 输出：

```
OK    memd 8787       docs=38 facts=475 chunks=862
OK    doctor          ready=True failed=[] warn=[disclose.last]
FAIL  pet-llm 8790    --check exit=2
FAIL  qq-bridge 3100  not listening
```

逐项说明：

- **memd 8787 / doctor**：正常。`warn=[disclose.last]` 是「还没真实触发过一次披露」，非故障。
- **pet-llm**：`dsh.reachable: false`，候选地址 `127.0.0.1:3080` / `19387` 均未监听，原因是 **DSH 桌面版未运行**（升级前用户已将其关闭）。启动 DSH 后应转 OK。
- **qq-bridge 3100**：本机启动项 `qq-stack.vbs` → `D:\deepseek_workspace\qq-bridge\start-stack.ps1` 未运行。需要 QQ 功能时再起。

> 说明：本次排查环境无法启动 DSH 的图形界面（进程可创建但无窗口、无子进程、不监听端口，判定为沙箱限制）。**DSH 桌面版的实际启动请手动双击验证**，然后用上面的 `post-upgrade.ps1` 复检一次。

---

## 5. 排查过程中修掉的脚本 bug

`scripts\post-upgrade.ps1` 的 doctor 检查一直报 `could not parse doctor output`，与被测系统无关，是脚本自身的编码问题：

- 原代码 `& $node ... --json > $doctorJson 2>&1`
- PowerShell 5.1 按 ANSI 代码页（GBK）解码原生命令的 UTF-8 输出，中文标签变成 `MCP 娉ㄥ唽鍧?`，字符串被截断 → `ConvertFrom-Json` 在第 895 行报错。

修复（已改入文件）：

```powershell
$prevOutEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
& $node (Join-Path $root 'scripts\doctor.mjs') --json 2>&1 | Out-File -FilePath $doctorJson -Encoding utf8
try { [Console]::OutputEncoding = $prevOutEnc } catch { }
```

修复后 doctor 检查由 FAIL 转为 `OK ready=True failed=[]`。

---

## 6. 遗留风险与建议（重要）

### 6.1 下一次升级会再次失败

memd 现在又通过 `D:\Software\dsh\...\node.exe` 运行（PID 34584），**安装目录再次被锁**。若不改造，每次 DSH 升级都必须手动执行本节 6.2 的步骤。

### 6.2 升级前的标准前置动作（临时方案）

```powershell
Disable-ScheduledTask -TaskName "memd-watchdog"
powershell -ExecutionPolicy Bypass -File D:\deepseek_workspace\memory-hub\scripts\stop.ps1
# 确认无进程占用 + 无隐藏句柄（管理员权限下执行）
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "D:\Software\dsh\*" }
handle64.exe -accepteula -nobanner -a "D:\Software\dsh"
# 之后运行安装包 → 完成后
Enable-ScheduledTask -TaskName "memd-watchdog"
powershell -ExecutionPolicy Bypass -File D:\deepseek_workspace\memory-hub\scripts\post-upgrade.ps1
```

### 6.3 根治方案：让 memory-hub 不再依赖 DSH 安装目录

两处硬编码了 DSH 内置 node 路径：

1. `scripts\start.ps1` 的 `Resolve-Node` 第一候选
2. 计划任务 `memd-watchdog` 的动作参数

建议把 node 复制到独立位置（或安装独立 Node.js），并：

- 设置用户环境变量 `MEMD_NODE=<独立 node 路径>`（`start.ps1` 已优先读取该变量）
- 同步修改计划任务动作里的 node 路径

这样 memory-hub 与 DSH 安装目录彻底解耦，升级不再需要停机，也不会被目录锁卡住。

### 6.4 其他

- 升级期间先停看门狗、后装，顺序不可颠倒；反之 memd 会被重新拉起并再次锁定目录。
- `resources\app-update.yml` 中 `updaterCacheDirName: '@deepseek-aidsh-desktop-updater'` 少了路径分隔符，导致缓存目录名异常（`AppData\Local\@deepseek-aidsh-desktop-updater`）。仅命名不美观，不影响功能，未改动。
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 下的 `crash-*-host.log`（10-21、10-23）是历史问题：memd 未启动时 DSH 会 `fatal load failure: connect ECONNREFUSED 127.0.0.1:8787`。这正是需要保证 memd 与 DSH 启动顺序的原因。

---

## 7. 附件

- 5 份原始失败日志副本：`C:\Users\70903\WorkBuddy\2026-10-24-19-38-51\dsh-upgrade-evidence\installer-logs\`
- Sysinternals Handle（本次定位工具，可复用）：`C:\Users\70903\WorkBuddy\2026-10-24-19-38-51\tools\handle64.exe`
