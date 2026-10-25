// 凭据脱敏（只抹掉「凭据赋值」形态的值，保留路径等上下文）。桥接审批展示与控制中心日志共用。
const CREDENTIAL_RE = /((?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?\s*(?:[:=：]|是|为)\s*["']?)([^\s，。；、"']{3,})/gi;
export function redactCredentials(text) {
  return String(text ?? '').replace(CREDENTIAL_RE, (_, k) => `${k}***`);
}

/** 把已知秘密（令牌原文）替换成 ***。 */
export function redactKnown(text, secrets = []) {
  let s = String(text ?? '');
  for (const t of secrets) if (t && t.length >= 8 && s.includes(t)) s = s.split(t).join('***');
  return s;
}
