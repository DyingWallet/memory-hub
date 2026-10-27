// 端口解析的唯一实现（JS 侧）。
//
// 为什么单独一个文件：桥接控制台端口配在 config.json 的 consolePort 里，但以前
// bridge.js / mcp-snowluma-safe.js / launcher/control-center.mjs 各自写了
// `?? 3100` / `|| 3100` 的 fallback。改一次端口要翻三四个文件，漏一个就会出现
// 「配置改了、某个工具还在打旧端口」的怪事（qq_wait_for_messages 曾报
// connect EADDRINUSE 127.0.0.1:3100，就是这个原因）。
//
// 现在所有 JS 消费点都从这里取，缺省值只在这里出现一次。
// 改端口 = 只改 config.json 的 consolePort（默认 3100）。

export const DEFAULT_CONSOLE_PORT = 3100;

/**
 * 把 config.json 里的 consolePort 规整成可用端口号。
 * 非数字、越界、缺失一律回退到 DEFAULT_CONSOLE_PORT。
 */
export function resolveConsolePort(cfg) {
  const n = Number(cfg?.consolePort);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_CONSOLE_PORT;
  return n;
}

/** 本机回环控制台基址，例如 http://127.0.0.1:3100 */
export function consoleBaseUrl(cfg) {
  return `http://127.0.0.1:${resolveConsolePort(cfg)}`;
}
