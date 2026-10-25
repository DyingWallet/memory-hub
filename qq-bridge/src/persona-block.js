// 从 AGENTS.md 抽「人格段」，注入 QQ 唤醒提示。
//
// 为什么不用手写副本：人格只在 AGENTS.md 维护一份，改完下次唤醒就生效，不用再同步。
// 只抽「我是谁」「语气」两节——「专业」「做事」「环境事实」「长期记忆」是桌面/终端向的，
// 进 QQ 会和 preset 的群聊规则打架（≤30 字 vs 带证据/表格），还会让模型去找
// qq-chat-v2 里根本不存在的 mcp__memory__* 工具。
import fs from 'node:fs';

/**
 * 取 markdown 里标题包含 keyword 的那一节正文（到下一个二级标题为止）。
 * 用「包含」而不是全等：标题加编号/改名时仍能命中。
 */
export function sectionBody(markdown, keyword) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+/.test(line) && line.includes(keyword));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * @param {object} options
 * @param {string} options.file       AGENTS.md 路径
 * @param {string[]} [options.sections] 要抽取的标题关键词
 * @param {(message: string) => void} [options.log]
 */
export function createPersonaReader({ file, sections = ['我是谁', '语气'], log = () => {} } = {}) {
  let cache = { mtime: 0, text: '' };

  return {
    /** 返回拼好的段落；读不到时返回上一次的结果（首次为空串）。 */
    read() {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs === cache.mtime) return cache.text;
        const markdown = fs.readFileSync(file, 'utf8');
        const picked = sections
          .map((name) => sectionBody(markdown, name))
          .filter((body) => body.length > 0)
          .join('\n\n');
        cache = { mtime: stat.mtimeMs, text: picked };
        if (!picked) log(`[persona] ${file} 里没抽到任何段落（标题改名了？）`);
        return picked;
      } catch (error) {
        log(`[persona] 读取失败：${error?.message ?? error}`);
        return cache.text;
      }
    },
  };
}
