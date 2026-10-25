// 结构化日志：内存环形缓冲 + stdout 一行一条 JSON（控制中心按字段筛选；进程崩溃时它仍保有最后的输出）。
//
// 字段：seq、time、level（debug/info/warn/error）、scope（core / instance / account / compat / api）、
//       instance、account、msg。所有文本先经过脱敏：已知令牌原样替换，再按通用规则抹掉 token=…、Bearer … 等。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function redactText(text, secrets = []) {
  let s = String(text ?? '');
  for (const sec of secrets) {
    if (sec && sec.length >= 6) s = s.split(sec).join(`${sec.slice(0, 2)}…`);
  }
  return s
    .replace(/(access_token=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{6,}/g, '$1***')
    .replace(/("?(?:accessToken|access_token|token|password)"?\s*[:=]\s*"?)[^"\s,}]{4,}/gi, '$1***');
}

export function createLogger({ maxLines = 5000, minLevel = 'info', stdout = true, secrets = () => [], now = Date.now } = {}) {
  let seq = 0;
  const lines = [];
  const min = LEVELS[minLevel] ?? 20;

  function write(level, scope, msg, ctx = {}) {
    if ((LEVELS[level] ?? 20) < min) return null;
    seq += 1;
    const entry = {
      seq,
      time: now(),
      level,
      scope,
      ...(ctx.instance ? { instance: ctx.instance } : {}),
      ...(ctx.account ? { account: ctx.account } : {}),
      msg: redactText(msg, secrets()),
    };
    lines.push(entry);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    if (stdout) {
      try { process.stdout.write(`${JSON.stringify({ pl: 1, ...entry })}\n`); } catch {}
    }
    return entry;
  }

  const api = {
    debug: (scope, msg, ctx) => write('debug', scope, msg, ctx),
    info: (scope, msg, ctx) => write('info', scope, msg, ctx),
    warn: (scope, msg, ctx) => write('warn', scope, msg, ctx),
    error: (scope, msg, ctx) => write('error', scope, msg, ctx),
    /** 按条件取日志：after=序号，level=最低级别，scope/instance/account 精确匹配。 */
    query({ after = 0, level = null, scope = null, instance = null, account = null, limit = 1000 } = {}) {
      const lv = level ? (LEVELS[level] ?? 0) : 0;
      return lines.filter((l) => l.seq > after
        && LEVELS[l.level] >= lv
        && (!scope || l.scope === scope)
        && (!instance || l.instance === instance)
        && (!account || l.account === account)).slice(-limit);
    },
    get lastSeq() { return seq; },
    /** 给某个实例/账号绑定上下文的子记录器。 */
    child(scope, ctx) {
      return {
        debug: (m, c) => write('debug', scope, m, { ...ctx, ...c }),
        info: (m, c) => write('info', scope, m, { ...ctx, ...c }),
        warn: (m, c) => write('warn', scope, m, { ...ctx, ...c }),
        error: (m, c) => write('error', scope, m, { ...ctx, ...c }),
      };
    },
  };
  return api;
}
