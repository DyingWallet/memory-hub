// DSH 回合错误的分类与展示（v0.4.1）。
//
// 背景（部署实测）：DSH 缺模型凭据时报 `llm-deepseek: no API key for provider route "deepseek-official" …
// code "MISSING_CREDENTIAL"`。原来的出错分支只把错误发到 QQ、不写日志，而且错误文本里含 credential 一词，
// 被 SENSITIVE_RE 整条替换成「（含敏感信息，已隐藏）」—— 部署者完全看不到原因。
//
// 现在：
//   · 错误码（MISSING_CREDENTIAL / INVALID_CREDENTIAL / HTTP 状态等）本身不含秘密，总是可以展示和记录；
//   · 日志写「错误码 + 脱敏后的前 200 字」（只抹掉凭据赋值、令牌与本机路径，保留能定位问题的文字）；
//   · 群聊等需要审计的会话只显示错误码和一句通俗说明，不显示原文；
//   · 配置类错误（缺凭据、余额不足）由调用方私聊提醒 owner（带限频）。

import { redactCredentials, redactKnown } from './redact.mjs';

const PATH_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/root\/)[^\s"'<>|]*)/g;

const KINDS = [
  { kind: 'credential', re: /MISSING_CREDENTIAL|INVALID_CREDENTIAL|no api key|api key (?:is )?(?:invalid|missing)|unauthori[sz]ed|\b401\b/i, hint: 'DSH 没有可用的模型凭据：请在 DSH 设置里填写 DeepSeek API Key 或登录 DeepSeek 账号，并确认 config.json 的 dsh.provider 与之对应（API Key = deepseek-official，账号登录 = deepseek-account）' },
  { kind: 'quota', re: /insufficient|balance|quota|\b402\b|余额/i, hint: '模型账户余额不足或额度用完：请到 DeepSeek 平台充值或检查额度' },
  { kind: 'rate', re: /rate.?limit|too many requests|\b429\b/i, hint: '模型接口限流：稍后会自动恢复；频繁出现时可降低唤醒频率' },
  { kind: 'model', re: /model.{0,40}(?:not found|unknown|unavailable)|MODEL_NOT_FOUND/i, hint: '模型不可用：检查 config.json 的 dsh.model 是否在 DSH 的模型列表里' },
  { kind: 'network', re: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|fetch failed|socket hang up|timeout/i, hint: '连接模型服务失败：检查网络或代理' },
];

/** 从错误对象里取一个不含秘密的错误码。 */
export function agentErrorCode(error) {
  const direct = error?.code ?? error?.data?.code ?? error?.details?.code;
  if (typeof direct === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,60}$/.test(direct)) return direct;
  if (typeof direct === 'number') return `HTTP_${direct}`;
  const msg = String(error?.message ?? error ?? '');
  const quoted = /code[\s:=]*["'`]?([A-Z][A-Z0-9_]{3,60})["'`]?/.exec(msg);
  if (quoted) return quoted[1];
  const status = /\b(4\d\d|5\d\d)\b/.exec(msg);
  if (status) return `HTTP_${status[1]}`;
  return 'UNKNOWN';
}

/**
 * @param {unknown} error   DSH 回合结束原因里的 error（或 accepted.result.error）
 * @param {object} [o]
 * @param {string[]} [o.secrets]  需要精确抹掉的已知秘密（会话令牌等）
 * @returns {{code:string, kind:string, hint:string|null, logText:string, detail:string}}
 */
export function describeAgentError(error, { secrets = [] } = {}) {
  const code = agentErrorCode(error);
  const raw = String(error?.message ?? (typeof error === 'string' ? error : '') ?? '');
  const match = KINDS.find((k) => k.re.test(`${code} ${raw}`));
  const detail = redactKnown(redactCredentials(raw), secrets).replace(PATH_RE, '<路径>').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    code,
    kind: match?.kind ?? 'other',
    hint: match?.hint ?? null,
    detail,
    logText: `[${code}] ${detail || '（无错误信息）'}`,
  };
}

/** 给 QQ 看的一句话。audited=true（群聊、非 owner 会话）时不带原文。 */
export function agentErrorUserText(d, { audited }) {
  const head = `⚠️ AI 处理出错（错误码 ${d.code}）`;
  if (audited) return `${head}，已记录，管理员会处理。`;
  return `${head}${d.hint ? `：${d.hint}` : ''}${d.detail ? `\n详情：${d.detail}` : ''}`;
}

/** 是否属于需要提醒 owner 去改配置的错误。 */
export function isConfigError(d) {
  return d.kind === 'credential' || d.kind === 'quota' || d.kind === 'model';
}
