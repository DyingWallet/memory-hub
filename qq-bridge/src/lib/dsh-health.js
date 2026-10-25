// DSH 健康检查的判定：连续失败几次才算「不可用」，以及失败原因的分类（写进日志）。
//
// 背景：桥接每 5 秒调一次 settings/describe 探活。以前只要失败一次就宣布「DSH 不可用」并把 QQ 消息入队，
// 而 DSH 很忙（例如本机满负载渲染、DSH 正在处理大回合）时偶尔一次没及时回应，就会刷出一条误报。
// 现在：连续 threshold 次（默认 2 次，约 10 秒）失败才判定不可用；偶发失败一次只在恢复时记一笔。
// 端口重新识别不受影响 —— 第一次失败就开始（见 bridge.js 的 checkDsh）。
// 本模块只放纯逻辑，桥接负责接线。

/** 失败原因分类：timeout（超时）/ refused（连接被拒，多半 DSH 没在运行或换了端口）/ reset / auth / http / other。 */
export function classifyDshError(err) {
  const codes = new Set();
  const collect = (e, depth = 0) => {
    if (!e || depth > 4) return;
    if (typeof e.code === 'string') codes.add(e.code);
    if (typeof e.name === 'string') codes.add(e.name);
    if (e.cause) collect(e.cause, depth + 1);
    if (Array.isArray(e.errors)) for (const x of e.errors) collect(x, depth + 1);
  };
  collect(err);
  const msg = String(err?.message ?? err ?? '');
  const has = (...xs) => xs.some((x) => codes.has(x));
  if (has('TimeoutError', 'AbortError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT') || /timed? ?out|timeout|超时/i.test(msg)) {
    return { kind: 'timeout', label: '超时（DSH 没有及时回应，可能正忙）' };
  }
  if (has('ECONNREFUSED') || /ECONNREFUSED/.test(msg)) {
    return { kind: 'refused', label: '连接被拒（DSH 没在运行，或换了端口）' };
  }
  if (has('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET') || /ECONNRESET|socket hang up|other side closed/i.test(msg)) {
    return { kind: 'reset', label: '连接被中断' };
  }
  const http = /HTTP (\d{3})/.exec(msg);
  if ((http && http[1] === '401') || /unauthori[sz]ed/i.test(msg)) return { kind: 'auth', label: '鉴权失败（HTTP 401）' };
  if (http) return { kind: 'http', label: `HTTP ${http[1]}` };
  const short = msg.replace(/\s+/g, ' ').trim().slice(0, 80);
  return { kind: 'other', label: short ? `其他错误：${short}` : '其他错误' };
}

/**
 * 连续失败计数器。
 *   fail(err) → { failures, reason, unavailable }：unavailable = 已连续失败 threshold 次；
 *   ok()      → { recoveredFrom, reason }：恢复前连续失败了几次、最后一次的原因（没失败过为 0 / null）。
 */
export function createDshHealth({ threshold = 2 } = {}) {
  const need = Math.max(1, Math.floor(Number(threshold) || 2));
  let failures = 0;
  let reason = null;
  return {
    threshold: need,
    fail(err) {
      failures += 1;
      reason = classifyDshError(err);
      return { failures, reason, unavailable: failures >= need };
    },
    ok() {
      const r = { recoveredFrom: failures, reason };
      failures = 0;
      reason = null;
      return r;
    },
    get failures() { return failures; },
  };
}
