/**
 * 短期记忆入库前的清洗规则。
 *
 * 为什么放在服务端（`/v1/ingest`）而不是各客户端：
 * 上游有三条——QQ 桥接、`dsh-memory` 插件、桌宠——每一条都可能把占位符、
 * 内部 prompt、工具报错当成聊天写进来。在入口统一过滤，新增上游也不会漏；
 * 客户端侧再修各自的根因（桌宠别把 system prompt 当 user message）。
 *
 * 规则刻意保守：只丢「确定没有信息」的内容，宁可漏过滤也不误杀正常对话。
 * 所有阈值都可从 `config.shortTerm.ingestFilter` 覆盖。
 */

/** 纯占位的消息形态：图片/表情/卡片等，剥离后若没正文就是空消息。 */
const DEFAULT_PLACEHOLDERS =
  /\[(?:图片|卡片消息|表情\d*|语音|视频|文件|转发消息|嵌套转发|动画表情|闪照|位置|链接|小程序|音乐|红包|骰子|猜拳|戳一戳|拍一拍)\]/g;

/**
 * 「内部 prompt 被当聊天发进来」的前缀。
 *
 * 只匹配开头 + 要求够长（默认 80 字符）：正常用户不会用这种长句开头，
 * 而系统提示词/学习器 prompt/工具报错都又长又固定。
 */
const DEFAULT_INTERNAL_PREFIXES = [
  '你是主人桌面上的',
  '你是一个群聊黑话学习器',
  'You are an AI agent',
  'You are a helpful assistant',
  'You are repeating the exact same tool',
];

export interface IngestFilterOptions {
  placeholders?: RegExp;
  minChars?: number;
  internalPrefixes?: string[];
  internalMinLength?: number;
}

export type IngestDropReason = 'empty' | 'placeholder-only' | 'too-short' | 'internal-prompt';

export interface IngestFilterResult {
  text: string;
  drop: boolean;
  reason?: IngestDropReason;
}

/** 规范化空白：折叠连续空白与换行，和渲染时的处理保持一致。 */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function cleanIngestText(raw: string, options: IngestFilterOptions = {}): IngestFilterResult {
  const placeholders = options.placeholders ?? DEFAULT_PLACEHOLDERS;
  const minChars = options.minChars ?? 2;
  const internalPrefixes = options.internalPrefixes ?? DEFAULT_INTERNAL_PREFIXES;
  const internalMinLength = options.internalMinLength ?? 80;

  const original = collapse(String(raw ?? ''));
  if (original.length === 0) return { text: '', drop: true, reason: 'empty' };

  // 先剥离占位符：`[图片] 今天天气不错` 要保留正文，`[图片]` 只剩空串才丢。
  const stripped = collapse(original.replace(placeholders, ' '));
  if (stripped.length === 0) return { text: '', drop: true, reason: 'placeholder-only' };

  // 内部 prompt：开头命中 + 足够长。短句即使同开头也当正常聊天。
  for (const prefix of internalPrefixes) {
    if (stripped.startsWith(prefix) && stripped.length >= internalMinLength) {
      return { text: '', drop: true, reason: 'internal-prompt' };
    }
  }

  if (stripped.length < minChars) return { text: '', drop: true, reason: 'too-short' };

  return { text: stripped, drop: false };
}
