// DSH 模型选择：提供方 / 模型 / 思考强度 / 看图能力。
//
// 职责（bridge.js 只负责接线）：
// - session.modelCatalog 的缓存（60 秒 TTL、并发去重、超时）；
// - 把目录整理成控制台的三个联动下拉需要的形状；
// - 服务端硬校验：提供方 / 模型不在目录里、档位不在该模型公布的列表里都拒绝；
// - 生成 session.selectModel 的参数（无档位模型不带 reasoningEffort）；
// - 看图能力判断与「不能看图时把图片降级成文字」；
// - 第三方提供方的隐私提示、价格表是否覆盖。
//
// 目录形状（DSH 0.2.x 实测）：
//   { default: { provider, model, reasoningEffort }, routableProviders: [...],
//     groups: [{ id, name, models: [{ id, name, description?, reasoning?: { efforts: [{ id, name, description? }], defaultEffort? } }] }],
//     failures: [{ id, name, message }] }
// 目录条目**不含** inputModalities（只有各 provider 插件自己知道），所以看图能力用「已知表 + 未知」表达。

/** DSH 已知的全部思考档位。config.json 里的值先按它校验，具体模型支持哪些以目录为准。 */
export const KNOWN_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** 目录取不到时的内置档位（DeepSeek 自家模型的常用档）。 */
export const FALLBACK_EFFORTS = Object.freeze(['low', 'high', 'max']);
export const DEFAULT_PROVIDER = 'deepseek-official';
export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_EFFORT = 'max';

/**
 * DeepSeek 自家的提供方：命令行版叫 deepseek-official，桌面版 0.2.1 起叫 deepseek-account。
 * 其它提供方都是第三方——QQ 聊天内容会发给它们，控制台要提示隐私；价格表也只覆盖这两个。
 */
export const FIRST_PARTY_PROVIDERS = Object.freeze(['deepseek-official', 'deepseek-account']);

/**
 * 已知能看图的模型（`提供方/模型`）。目录不公布 inputModalities，这里只收录核实过的；
 * 不在表里的一律算「未知」，按不能看图处理（图片降级成文字，避免整条消息报
 * UNSUPPORTED_CONTENT / MODEL_DOES_NOT_SUPPORT_IMAGES）。管理员可以在控制台手动指定。
 */
export const KNOWN_VISION = Object.freeze({
  'deepseek-official/deepseek-flash': true,
  'deepseek-account/deepseek-flash': true,
});

/** 看图能力设置：auto = 按已知表（未知按不能看图）；yes / no = 管理员手动指定。 */
export const VISION_SETTINGS = Object.freeze(['auto', 'yes', 'no']);

const clean = (v) => String(v ?? '').trim();

/**
 * 规范化档位。空值表示「用模型默认」（selectModel 不带 reasoningEffort）。
 * @param {{ allowNone?: boolean }} opts allowNone=false 时空值也算错
 */
export function normalizeEffortId(value, { allowNone = true } = {}) {
  const v = clean(value).toLowerCase();
  if (!v) {
    if (allowNone) return '';
    throw new Error('请选择思考强度');
  }
  if (!KNOWN_EFFORTS.includes(v)) throw new Error(`思考强度只能是 ${KNOWN_EFFORTS.join(' / ')}`);
  return v;
}

export function normalizeVisionSetting(value) {
  const v = clean(value).toLowerCase();
  return VISION_SETTINGS.includes(v) ? v : 'auto';
}

export function isFirstPartyProvider(provider) {
  return FIRST_PARTY_PROVIDERS.includes(clean(provider));
}

/** 已知表里的看图能力：'yes' | 'unknown'（目录没有否定信息，所以不会给出 'no'）。 */
export function knownVision(provider, model) {
  return KNOWN_VISION[`${clean(provider)}/${clean(model)}`] ? 'yes' : 'unknown';
}

/** 实际是否把图片交给模型：手动指定优先，auto 时只有已知能看图才给。 */
export function canSeeImages({ provider, model, vision } = {}) {
  const setting = normalizeVisionSetting(vision);
  if (setting === 'yes') return true;
  if (setting === 'no') return false;
  return knownVision(provider, model) === 'yes';
}

/** 价格表是否覆盖：只收录 DeepSeek 自家价目，第三方同名模型也不算。 */
export function isPriced(provider, model, priceTable) {
  return isFirstPartyProvider(provider) && !!priceTable?.models?.[clean(model)];
}

/** 目录里某个模型公布的档位 id 列表（无档位模型返回 []）。 */
export function catalogEfforts(entry) {
  const efforts = entry?.reasoning?.efforts;
  return Array.isArray(efforts) ? efforts.map((e) => clean(e?.id)).filter(Boolean) : [];
}

export function findCatalogModel(catalog, provider, model) {
  const group = (catalog?.groups ?? []).find((g) => g?.id === clean(provider));
  const entry = (group?.models ?? []).find((m) => m?.id === clean(model));
  return { group: group ?? null, entry: entry ?? null };
}

/**
 * 模型目录缓存：60 秒 TTL，同一时刻只发一个请求（withTimeout 不会取消底层 RPC，并发刷新会堆积），
 * 超时 / 失败返回 { ok:false, error }，调用方据此退化，不抛异常。
 * @param {{ fetchCatalog: () => Promise<object>, ttlMs?: number, timeoutMs?: number, now?: () => number }} opts
 */
export function createModelCatalogCache({ fetchCatalog, ttlMs = 60_000, timeoutMs = 3_000, now = Date.now } = {}) {
  let cached = null; // { at, catalog }
  let inFlight = null;
  async function fetchOnce() {
    let timer;
    try {
      const catalog = await Promise.race([
        Promise.resolve().then(() => fetchCatalog()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`读取 DSH 模型目录超时（${timeoutMs}ms）`)), timeoutMs); }),
      ]);
      if (!catalog || !Array.isArray(catalog.groups)) throw new Error('DSH 模型目录格式不对（缺少 groups）');
      cached = { at: now(), catalog };
      return { ok: true, catalog };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async get({ force = false } = {}) {
      if (!force && cached && now() - cached.at < ttlMs) return { ok: true, catalog: cached.catalog, cached: true };
      if (!inFlight) inFlight = fetchOnce().finally(() => { inFlight = null; });
      return inFlight;
    },
    invalidate() { cached = null; },
  };
}

/**
 * 校验控制台提交的选择。目录是唯一依据：不在目录里的提供方 / 模型、不在该模型列表里的档位一律拒绝。
 * @returns {{ provider, model, reasoningEffort, vision }} reasoningEffort 为 '' 表示用模型默认
 * @throws Error（message 给管理员看）
 */
export function validateModelSelection(catalog, { provider, model, reasoningEffort, vision } = {}) {
  const p = clean(provider);
  const m = clean(model);
  if (!p || !m) throw new Error('请选择提供方和模型');
  const { group, entry } = findCatalogModel(catalog, p, m);
  if (!group) throw new Error(`DSH 的模型目录里没有提供方 ${p}`);
  if (!entry) throw new Error(`DSH 的模型目录里没有 ${p}/${m}`);
  const supported = catalogEfforts(entry);
  let effort = normalizeEffortId(reasoningEffort);
  if (!supported.length) {
    effort = ''; // 无档位模型：忽略传入的档位，selectModel 不带该字段
  } else if (effort && !supported.includes(effort)) {
    throw new Error(`${p}/${m} 只支持思考强度 ${supported.join(' / ')}`);
  }
  return { provider: p, model: m, reasoningEffort: effort, vision: normalizeVisionSetting(vision) };
}

/**
 * 生成 session.selectModel 的参数。目录可用时按目录修正档位：无档位模型不带、
 * 档位不被支持时去掉（交给模型默认，并回一条 warning）；目录不可用时按配置原样传（不阻塞聊天）。
 */
export function resolveSelectModelParams(dshCfg = {}, catalog = null) {
  const provider = clean(dshCfg.provider) || DEFAULT_PROVIDER;
  const model = clean(dshCfg.model) || DEFAULT_MODEL;
  let effort = '';
  try { effort = normalizeEffortId(dshCfg.reasoningEffort); } catch { effort = ''; }
  let warning = '';
  if (catalog) {
    const { entry } = findCatalogModel(catalog, provider, model);
    if (entry) {
      const supported = catalogEfforts(entry);
      if (!supported.length) effort = '';
      else if (effort && !supported.includes(effort)) {
        warning = `${provider}/${model} 不支持思考强度 ${effort}（支持 ${supported.join(' / ')}），本次用模型默认`;
        effort = '';
      }
    }
  }
  return { params: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }, warning };
}

/** 控制台用的目录视图：每个模型带上档位、默认档、看图能力（已知表）、价格是否覆盖、是否第三方。 */
export function buildCatalogView(catalog, { priceTable } = {}) {
  const providers = (catalog?.groups ?? []).filter((g) => g?.id).map((g) => ({
    id: String(g.id),
    name: String(g.name ?? g.id),
    thirdParty: !isFirstPartyProvider(g.id),
    models: (g.models ?? []).filter((m) => m?.id).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      description: String(m.description ?? ''),
      efforts: (m.reasoning?.efforts ?? []).filter((e) => e?.id).map((e) => ({
        id: String(e.id), name: String(e.name ?? e.id), description: String(e.description ?? ''),
      })),
      defaultEffort: m.reasoning?.defaultEffort ? String(m.reasoning.defaultEffort) : null,
      vision: knownVision(g.id, m.id),
      priced: isPriced(g.id, m.id, priceTable),
    })),
  }));
  const failures = (catalog?.failures ?? []).map((f) => ({ id: String(f?.id ?? ''), name: String(f?.name ?? f?.id ?? ''), message: String(f?.message ?? '') }));
  return { providers, failures };
}

/** 给管理员的提示（控制台与接口共用，保证措辞一致）。 */
export function selectionNotices({ provider, model, reasoningEffort, vision, priced }) {
  const notices = [];
  if (!isFirstPartyProvider(provider)) {
    notices.push({ level: 'warn', code: 'third-party', text: `${provider} 不是 DeepSeek 自家的提供方：QQ 里的聊天内容（群友消息、图片、人格卡、记忆）会发给它处理，请先确认它的隐私政策。` });
  }
  if (reasoningEffort === 'off') {
    notices.push({ level: 'warn', code: 'effort-off', text: '思考已关闭：回复更快，但二代仿真里的工具调用、读群判断和人格一致性可能变差。' });
  }
  if (!canSeeImages({ provider, model, vision })) {
    notices.push({ level: 'info', code: 'no-vision', text: normalizeVisionSetting(vision) === 'no'
      ? '已设为不能看图：QQ 里的图片、表情会改成文字占位（例如「[图片1：当前模型不能看图，已省略]」）。'
      : '这个模型能不能看图未知：按不能看图处理，图片、表情会改成文字占位；确认它能看图的话，把「看图能力」改成「能看图」。' });
  }
  if (!priced) {
    notices.push({ level: 'info', code: 'unpriced', text: '价格表没有覆盖这个模型：令牌与花费页的金额按 DeepSeek-V4.1-Flash 估算，并标「估算」。' });
  }
  return notices;
}

/** 不能看图时，聊天消息里的图片 / 表情改成文字占位（不去下载图片）。 */
export function mediaTextParts(mediaList, modelLabel = '') {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const who = modelLabel ? `当前模型 ${modelLabel}` : '当前模型';
  return list.filter((m) => m && typeof m === 'object').map((media, i) => {
    const index = i + 1;
    if (media.kind === 'face') return { type: 'text', text: `[表情#${clean(media.faceId) || index}]` };
    const sticker = media.kind === 'sticker';
    const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
    const label = sticker ? (summary ? `表情${summary}` : `表情${index}`) : `图片${index}`;
    return { type: 'text', text: `[${label}：${who}不能看图，已省略]` };
  });
}

/** 不能看图时，工具查询图片（qq_get_message_images / 转发内图片）返回的条目：只有文字，不带 data。 */
export function mediaTextEntries(mediaList, modelLabel = '') {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const who = modelLabel ? `当前模型 ${modelLabel}` : '当前模型';
  return list.filter((m) => m && typeof m === 'object').map((media, i) => ({
    index: i + 1,
    kind: media.kind === 'face' ? 'face' : (media.kind === 'sticker' ? 'sticker' : 'image'),
    text: `（${who}不能看图，已省略）`,
  }));
}
