// 系统原生的「选择文件夹 / 选择文件」窗口（只在用户点击「浏览…」时由控制中心调用）。
//   · Windows：PowerShell + System.Windows.Forms（FolderBrowserDialog / OpenFileDialog）；
//   · macOS：osascript 的 choose folder / choose file（标准附加功能，不需要「自动化」授权）；
//   · Linux：有 zenity（GNOME 等）就用 zenity，否则有 kdialog（KDE）就用 kdialog；都没有（例如无图形界面的服务器）时返回 null，在页面里手动填路径。
// 标题、初始目录、过滤器一律经环境变量（Windows）或 argv（macOS）传入，不拼进脚本，避免注入。
// 用户取消时返回 null。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 在 PATH 里找可执行文件（只看文件是否存在且可执行，不运行它）。 */
export function findInPath(name, env = process.env, exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    if (exists(p)) return p;
  }
  return null;
}

const KINDS = new Set(['folder', 'file', 'app']);

// macOS：argv = [标题, 种类, 初始目录, 扩展名（逗号分隔，可空）]
const MAC_SCRIPT = `on run argv
  set t to item 1 of argv
  set k to item 2 of argv
  set d to item 3 of argv
  set exts to item 4 of argv
  set loc to missing value
  if d is not "" then
    try
      set loc to (POSIX file d) as alias
    end try
  end if
  activate
  try
    if k is "folder" then
      if loc is missing value then
        set r to choose folder with prompt t
      else
        set r to choose folder with prompt t default location loc
      end if
    else if k is "app" then
      if loc is missing value then
        set r to choose file with prompt t of type {"com.apple.application-bundle"}
      else
        set r to choose file with prompt t of type {"com.apple.application-bundle"} default location loc
      end if
    else
      set AppleScript's text item delimiters to ","
      set typeList to text items of exts
      set AppleScript's text item delimiters to ""
      if exts is "" then
        if loc is missing value then
          set r to choose file with prompt t
        else
          set r to choose file with prompt t default location loc
        end if
      else
        if loc is missing value then
          set r to choose file with prompt t of type typeList
        else
          set r to choose file with prompt t of type typeList default location loc
        end if
      end if
    end if
    return POSIX path of r
  on error number -128
    return ""
  end try
end run`;

const WIN_FOLDER = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:QQB_PICK_TITLE',
  'if ($env:QQB_PICK_INIT -and (Test-Path $env:QQB_PICK_INIT)) { $d.SelectedPath = $env:QQB_PICK_INIT }',
  '$d.ShowNewFolderButton = $false',
  '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}',
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }',
].join('; ');

const WIN_FILE = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  '$d.Title = $env:QQB_PICK_TITLE',
  'if ($env:QQB_PICK_FILTER) { $d.Filter = $env:QQB_PICK_FILTER }',
  'if ($env:QQB_PICK_INIT -and (Test-Path $env:QQB_PICK_INIT)) { $d.InitialDirectory = $env:QQB_PICK_INIT }',
  '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}',
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }',
].join('; ');

/**
 * 生成调用参数（纯函数，便于测试）。返回 { command, args, env } 或 null（本系统不支持）。
 * @param {{kind?:'folder'|'file'|'app', title?:string, initialDir?:string, extensions?:string[], platform?:string, env?:object}} opts
 */
export function pickDialogSpec({ kind = 'folder', title = '', initialDir = '', extensions = [], platform = process.platform, env = process.env, which = (n) => findInPath(n, env) } = {}) {
  if (!KINDS.has(kind)) throw new Error(`不支持的选择种类：${kind}`);
  const exts = extensions.map((e) => String(e).replace(/^\./, '')).filter((e) => /^[a-z0-9]{1,8}$/i.test(e));
  if (platform === 'darwin') {
    return { command: '/usr/bin/osascript', args: ['-e', MAC_SCRIPT, String(title), kind, String(initialDir || ''), exts.join(',')], env: { ...env } };
  }
  if (platform === 'win32') {
    const ps = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const filter = exts.length ? `${title || '文件'} (${exts.map((e) => `*.${e}`).join(';')})|${exts.map((e) => `*.${e}`).join(';')}` : '';
    // Windows 没有「应用包」：app 按普通文件处理
    const script = kind === 'folder' ? WIN_FOLDER : WIN_FILE;
    return { command: ps, args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], env: { ...env, QQB_PICK_TITLE: String(title), QQB_PICK_INIT: String(initialDir || ''), QQB_PICK_FILTER: filter } };
  }
  if (platform === 'linux') {
    // Linux 没有「应用包」：app 按普通文件处理
    const zenity = which('zenity');
    if (zenity) {
      const args = ['--file-selection', `--title=${String(title)}`];
      if (kind === 'folder') args.push('--directory');
      if (initialDir) args.push(`--filename=${String(initialDir).replace(/\/?$/, '/')}`);
      if (kind !== 'folder' && exts.length) args.push(`--file-filter=${title || '文件'} | ${exts.map((e) => `*.${e}`).join(' ')}`, '--file-filter=全部文件 | *');
      return { command: zenity, args, env: { ...env } };
    }
    const kdialog = which('kdialog');
    if (kdialog) {
      const start = String(initialDir || env.HOME || '/');
      const args = kind === 'folder'
        ? ['--getexistingdirectory', start, '--title', String(title)]
        : ['--getopenfilename', start, exts.length ? exts.map((e) => `*.${e}`).join(' ') : '*', '--title', String(title)];
      return { command: kdialog, args, env: { ...env } };
    }
    return null;
  }
  return null;
}

/** 把窗口返回的文字整理成路径：去掉换行；macOS 的文件夹 / 应用包路径末尾带 /，去掉（根目录除外）。 */
export function normalizePickedPath(stdout) {
  let p = String(stdout ?? '').trim();
  if (!p) return null;
  if (p.length > 1 && /[\\/]$/.test(p)) p = p.replace(/[\\/]+$/, '');
  return p || null;
}

/** 弹出选择窗口；返回所选路径，取消或不支持时返回 null。 */
export function pickDialog(opts = {}, { run = execFile, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let spec;
    try { spec = pickDialogSpec(opts); } catch { return resolve(null); }
    if (!spec) return resolve(null);
    run(spec.command, spec.args, { windowsHide: false, timeout: timeoutMs, encoding: 'utf8', env: spec.env }, (err, stdout) => {
      resolve(err ? null : normalizePickedPath(stdout));
    });
  });
}
