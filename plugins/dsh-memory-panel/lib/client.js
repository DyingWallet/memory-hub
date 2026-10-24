// Browser half of the memory-hub settings panel.
//
// Read-write: health is public; config read/write needs the desktop root token
// (`~/.dsh/memory-token`), which the page stores in localStorage.
window.__ModuleLoader__.load({
  id: 'dsh-memory-panel',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const { useEffect, useState } = React;
    // Same-origin proxy routes registered by the host half (Local Network
    // Access blocks direct 127.0.0.1 fetches from the renderer).
    const PATH_HEALTH = '/memory-hub/health';
    const PATH_CONFIG_STATE = '/memory-hub/config-state';
    const PATH_CONFIG = '/memory-hub/config';
    const PATH_TOKENS = '/memory-hub/tokens';
    const PATH_REVOKE = '/memory-hub/tokens/revoke';
    const PATH_TIMELINE = '/memory-hub/timeline';
    const TOKEN_KEY = 'memory-panel-token';
    const h = React.createElement;

    function Row({ label, value }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            padding: '6px 0',
            borderBottom: '1px solid rgba(127,127,127,0.15)',
          },
        },
        h('span', { style: { opacity: 0.7 } }, label),
        h('span', null, String(value)),
      );
    }

    /**
     * 一行「标签 + 输入框」，提示语紧跟在它自己的输入框下面（缩进到输入框那一列），
     * 不再把说明堆到页面末尾。
     */
    function Field({ label, hint, children }) {
      return h(
        'div',
        { style: { margin: '6px 0' } },
        h(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { width: 150, opacity: 0.8 } }, label),
          children,
        ),
        hint
          ? h(
              'p',
              { style: { opacity: 0.55, fontSize: 11, margin: '2px 0 0 158px', lineHeight: 1.5 } },
              hint,
            )
          : null,
      );
    }

    /** 一组相关字段：带边框的区块，区块自己的说明放在字段下面。 */
    function Section({ title, hint, tone, children }) {
      const hintColor = tone === 'warn' ? '#d94f3d' : undefined;
      return h(
        'div',
        {
          style: {
            margin: '12px 0',
            padding: '10px 12px',
            border: '1px solid ' + (tone === 'warn' ? 'rgba(217,79,61,0.5)' : 'rgba(127,127,127,0.18)'),
            borderRadius: 8,
          },
        },
        h('h4', { style: { margin: '0 0 6px', fontSize: 13 } }, title),
        children,
        hint
          ? h(
              'p',
              { style: { opacity: 0.6, fontSize: 11, margin: '6px 0 0', lineHeight: 1.5, color: hintColor } },
              hint,
            )
          : null,
      );
    }

    const inputStyle = { width: 90, padding: '2px 6px' };

    function NumberField({ label, value, onChange, min, max, step, hint }) {
      return h(
        Field,
        { label, ...(hint ? { hint } : {}) },
        h('input', {
          type: 'number',
          value,
          min,
          max,
          step: step ?? 1,
          style: inputStyle,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
      );
    }

    /** 语义检索那一组的状态说明：关闭 / 就绪 / 不可用，各自给出下一步。 */
    function semanticHint(semantic) {
      if (!semantic) return '';
      if (!semantic.enabled) return '关闭时只走 FTS（关键词/子串），不加载模型、不占内存。';
      if (semantic.ready) {
        return (
          '已就绪：' +
          semantic.vectors +
          ' 个向量（' +
          semantic.dim +
          ' 维，α=' +
          semantic.alpha +
          '，模型 ' +
          semantic.model +
          '）。开关只改配置，安装由 pnpm 管。'
        );
      }
      return (
        '已启用但不可用：' +
        (semantic.reason || '未知原因') +
        '。先在终端跑 pnpm fetch:model 下载模型（23 MB），再 pnpm embed 回填；在那之前检索仍走 FTS。'
      );
    }

    function MemoryPage() {
      const [health, setHealth] = useState({ loading: true });
      const [token, setToken] = useState(() => {
        try {
          return window.localStorage.getItem(TOKEN_KEY) ?? '';
        } catch {
          return '';
        }
      });
      const [config, setConfig] = useState(null);
      const [configError, setConfigError] = useState('');
      const [saveState, setSaveState] = useState('');
      const [tokens, setTokens] = useState(null);
      const [tokenError, setTokenError] = useState('');
      const [revokeState, setRevokeState] = useState('');
      // 「我写下的判断」：subject=self 的时间线，只读。
      const [judgements, setJudgements] = useState(null);
      const [judgementsError, setJudgementsError] = useState('');
      // 保存后用它触发一次 config-state 重新拉取：语义开关的 ready/vectors 会变。
      const [reloadKey, setReloadKey] = useState(0);

      const saveToken = (value) => {
        setToken(value);
        try {
          window.localStorage.setItem(TOKEN_KEY, value);
        } catch {
          // ignore storage failure (private mode)
        }
      };

      useEffect(() => {
        let alive = true;
        fetch(PATH_HEALTH, { cache: 'no-store' })
          .then((response) => response.json())
          .then((data) => {
            if (alive) setHealth({ loading: false, ok: true, data });
          })
          .catch((error) => {
            if (alive) setHealth({ loading: false, ok: false, error: String((error && error.message) || error) });
          });
        return () => {
          alive = false;
        };
      }, []);

      // 令牌框每敲一个字符就发请求太浪费（68 字符 = 136 个请求）。输入停下 300 ms
      // 才把值提交给下面的两个取数 effect；保存/吊销这些显式操作仍然用即时值。
      const [committedToken, setCommittedToken] = useState(token);
      useEffect(() => {
        const timer = setTimeout(() => setCommittedToken(token.trim()), 300);
        return () => clearTimeout(timer);
      }, [token]);

      useEffect(() => {
        const authToken = committedToken;
        let alive = true;
        setConfigError('');
        // 没填令牌也可以：宿主半侧会用 ~/.dsh/memory-token 兜底。
        fetch(PATH_CONFIG_STATE, {
          cache: 'no-store',
          ...(authToken ? { headers: { authorization: 'Bearer ' + authToken } } : {}),
        })
          .then(async (response) => {
            if (response.status === 401) throw new Error('令牌无效（HTTP 401）——留空则使用宿主注入的 root 令牌');
            if (response.status === 403) throw new Error('令牌不是 root（HTTP 403）');
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((data) => {
            if (alive) setConfig(data);
          })
          .catch((error) => {
            if (alive) {
              setConfig(null);
              setConfigError(String((error && error.message) || error));
            }
          });
        return () => {
          alive = false;
        };
      }, [committedToken, reloadKey]);

      useEffect(() => {
        const authToken = committedToken;
        let alive = true;
        setTokenError('');
        fetch(PATH_TOKENS, {
          cache: 'no-store',
          ...(authToken ? { headers: { authorization: 'Bearer ' + authToken } } : {}),
        })
          .then(async (response) => {
            if (response.status === 401 || response.status === 403) throw new Error('HTTP ' + response.status);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((data) => {
            if (alive) setTokens(data.tokens ?? []);
          })
          .catch((error) => {
            if (alive) {
              setTokens(null);
              setTokenError(String((error && error.message) || error));
            }
          });
        return () => {
          alive = false;
        };
      }, [committedToken, revokeState]);

      // 「我写下的判断」：只读，走 timeline 的 subject=self。
      useEffect(() => {
        const authToken = committedToken;
        let alive = true;
        setJudgementsError('');
        fetch(PATH_TIMELINE, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            ...(authToken ? { authorization: 'Bearer ' + authToken } : {}),
          },
          body: JSON.stringify({ subject: 'self', limit: 20, max_chars: 200 }),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((data) => {
            if (!alive) return;
            const items = [];
            for (const month of data.months || []) for (const item of month.items || []) items.push(item);
            // timeline 是旧→新，这里要新的在前。
            setJudgements(items.reverse());
          })
          .catch((error) => {
            if (alive) {
              setJudgements([]);
              setJudgementsError(String((error && error.message) || error));
            }
          });
        return () => {
          alive = false;
        };
      }, [committedToken, reloadKey]);

      const revoke = async (id) => {
        if (!window.confirm('吊销 token ' + id + '？吊销后立即失效。')) return;
        setRevokeState('吊销中…');
        try {
          const response = await fetch(PATH_REVOKE, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token.trim() ? { authorization: 'Bearer ' + token.trim() } : {}),
            },
            body: JSON.stringify({ id }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error((body && body.error && body.error.message) || 'HTTP ' + response.status);
          setRevokeState('已吊销 ' + id);
        } catch (error) {
          setRevokeState('吊销失败：' + String((error && error.message) || error));
        }
      };

      const patch = (section, key, value) => {
        setConfig((previous) =>
          previous ? { ...previous, [section]: { ...previous[section], [key]: value } } : previous,
        );
        setSaveState('');
      };

      const splitList = (text) =>
        text
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

      const save = async () => {
        if (!config) return;
        if (!window.confirm('确认保存配置？敏感记忆的可见范围会立即改变。')) return;
        setSaveState('保存中…');
        try {
          const response = await fetch(PATH_CONFIG, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token.trim() ? { authorization: 'Bearer ' + token.trim() } : {}),
            },
            body: JSON.stringify({
              shortTerm: { ...config.shortTerm },
              privacy: {
                sensitiveScope: config.privacy.sensitiveScope,
                sensitiveAudiences: config.privacy.sensitiveAudiences,
                ownerAudiences: config.privacy.ownerAudiences,
              },
              archive: { ...config.archive },
              semantic: { enabled: config.semantic.enabled },
            }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error((body && body.error && body.error.message) || 'HTTP ' + response.status);
          setSaveState('已保存：' + (body.applied || []).join(', '));
          // 语义开关是热生效的：重新拉一次状态，把 ready / 向量数 / 原因带回来。
          setReloadKey((value) => value + 1);
        } catch (error) {
          setSaveState('保存失败：' + String((error && error.message) || error));
        }
      };

      const healthBody = health.ok
        ? h(
            'div',
            null,
            h(Row, { label: '状态', value: '正常' }),
            h(Row, { label: '版本', value: health.data.version || '-' }),
            h(Row, { label: '已运行', value: (health.data.uptime_s ?? 0) + ' 秒' }),
            h(Row, { label: '文档', value: health.data.index?.docs ?? '-' }),
            h(Row, { label: '事实', value: health.data.index?.facts ?? '-' }),
            h(Row, { label: '索引块', value: health.data.index?.chunks ?? '-' }),
          )
        : h('p', null, '连不上 memd（经 DSH 代理）：' + (health.error || '读取中…'));

      return h(
        'div',
        null,
        h('h2', { style: { margin: '0 0 8px' } }, '记忆服务'),
        healthBody,
        h('h3', { style: { margin: '16px 0 4px' } }, '可编辑配置'),
        h(
          Field,
          {
            label: 'root 令牌（可留空）',
            hint:
              '留空时由宿主半侧自动注入 %USERPROFILE%\\.dsh\\memory-token；' +
              (token.trim() ? `当前手填了 ${token.trim().length} 字符（覆盖宿主令牌）` : '当前未手填'),
          },
          h('input', {
            type: 'password',
            value: token,
            placeholder: '留空 = 宿主注入',
            style: { width: 260, padding: '2px 6px' },
            onChange: (event) => saveToken(event.target.value),
          }),
        ),
        configError ? h('p', { style: { color: '#d94f3d' } }, configError) : null,
        !config
          ? h('p', { style: { opacity: 0.6, fontSize: 12 } }, '读取配置中…（若一直失败，检查 memd 与宿主令牌）')
          : h(
              'div',
              null,
              h(
                Section,
                {
                  title: '短期记忆',
                  hint: '普通聊天进短期层：到期未回顾会被遗忘，回顾过才转长期。',
                },
                h(NumberField, {
                  label: '短期 TTL（小时）',
                  value: config.shortTerm.ttlHours,
                  min: 0.1,
                  max: 720,
                  step: 0.1,
                  hint: '一条普通聊天默认保留多久',
                  onChange: (value) => patch('shortTerm', 'ttlHours', value),
                }),
                h(NumberField, {
                  label: 'TTL 上限（小时）',
                  value: config.shortTerm.maxTtlHours,
                  min: 0.1,
                  max: 8760,
                  step: 0.1,
                  hint: '被反复召回后最长能延长到（须 ≥ TTL）',
                  onChange: (value) => patch('shortTerm', 'maxTtlHours', value),
                }),
                h(NumberField, {
                  label: '回顾回看（小时）',
                  value: config.shortTerm.reviewLookbackHours,
                  min: 1,
                  max: 336,
                  hint: '回顾时往回看多远',
                  onChange: (value) => patch('shortTerm', 'reviewLookbackHours', value),
                }),
                h(NumberField, {
                  label: '回顾条数上限',
                  value: config.shortTerm.reviewLimit,
                  min: 1,
                  max: 100,
                  hint: '一次回顾最多列出多少条候选',
                  onChange: (value) => patch('shortTerm', 'reviewLimit', value),
                }),
                h(NumberField, {
                  label: '回顾间隔（小时）',
                  value: config.shortTerm.reviewIntervalHours,
                  min: 1,
                  max: 168,
                  hint: '两次回顾的最小间隔；到点会在 recall 结果里提示',
                  onChange: (value) => patch('shortTerm', 'reviewIntervalHours', value),
                }),
              ),
              h(
                Section,
                {
                  title: '隐私与可见范围',
                  hint: '逗号分隔。接入微信时把 wx:owner 加进这两个列表即可。',
                },
                h(
                  Field,
                  { label: '敏感记忆 scope', hint: '只有带这个 scope 的 token 才能读取敏感记忆' },
                  h('input', {
                    type: 'text',
                    value: config.privacy.sensitiveScope,
                    style: { width: 200, padding: '2px 6px' },
                    onChange: (event) => patch('privacy', 'sensitiveScope', event.target.value.trim()),
                  }),
                ),
                h(
                  Field,
                  { label: '敏感可见范围', hint: '敏感记忆只会写进这些范围；群和第三人永远看不到' },
                  h('input', {
                    type: 'text',
                    value: (config.privacy.sensitiveAudiences || []).join(', '),
                    style: { width: 280, padding: '2px 6px' },
                    onChange: (event) => patch('privacy', 'sensitiveAudiences', splitList(event.target.value)),
                  }),
                ),
                h(
                  Field,
                  { label: 'owner 可见范围', hint: '对方自己提起某话题时的临时披露范围' },
                  h('input', {
                    type: 'text',
                    value: (config.privacy.ownerAudiences || []).join(', '),
                    style: { width: 280, padding: '2px 6px' },
                    onChange: (event) => patch('privacy', 'ownerAudiences', splitList(event.target.value)),
                  }),
                ),
              ),
              h(
                Section,
                {
                  title: '月度归档',
                  hint: '默认关。开启后每月把更早的事实压成 .gz，索引照常可读。',
                },
                h(
                  Field,
                  { label: '月度归档' },
                  h('input', {
                    type: 'checkbox',
                    checked: config.archive.enabled,
                    onChange: (event) => patch('archive', 'enabled', event.target.checked),
                  }),
                ),
                h(NumberField, {
                  label: '保留最近几个月',
                  value: config.archive.keepMonths,
                  min: 0,
                  max: 120,
                  hint: '0 = 不裁剪',
                  onChange: (value) => patch('archive', 'keepMonths', value),
                }),
              ),
              h(
                Section,
                {
                  title: '语义检索',
                  tone: config.semantic.enabled && !config.semantic.ready ? 'warn' : undefined,
                  hint: semanticHint(config.semantic),
                },
                h(
                  Field,
                  { label: '语义检索' },
                  h('input', {
                    type: 'checkbox',
                    checked: config.semantic.enabled,
                    onChange: (event) => patch('semantic', 'enabled', event.target.checked),
                  }),
                ),
              ),
              h('button', { onClick: save, style: { marginTop: 8, cursor: 'pointer' } }, '保存'),
              saveState ? h('p', { style: { opacity: 0.8, fontSize: 12 } }, saveState) : null,
            ),
        h(
          'p',
          { style: { opacity: 0.6, marginTop: 12, fontSize: 12 } },
          '配置真源是 memory-hub/config.json；保存前会备份。签发新 token 仍在 admin CLI。',
        ),
        h('h3', { style: { margin: '16px 0 4px' } }, '令牌'),
        tokenError ? h('p', { style: { color: '#d94f3d' } }, tokenError) : null,
        !tokens
          ? h('p', { style: { opacity: 0.6, fontSize: 12 } }, '读取令牌列表中…（令牌走宿主注入，无需手填）')
          : null,
        tokens && tokens.length > 0
          ? h(
              'div',
              { style: { marginTop: 4 } },
              tokens.map((item) =>
                h(
                  'div',
                  {
                    key: item.id,
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      padding: '6px 0',
                      borderBottom: '1px solid rgba(127,127,127,0.12)',
                      fontSize: 12,
                    },
                  },
                  h(
                    'span',
                    { style: { opacity: 0.8 } },
                    `${item.name} · ${item.surface} · scopes=${(item.scopes || []).join(',')}` +
                      (item.revoked_at ? ' · 已吊销' : ''),
                  ),
                  item.revoked_at
                    ? null
                    : h(
                        'button',
                        { style: { cursor: 'pointer' }, onClick: () => revoke(item.id) },
                        '吊销',
                      ),
                ),
              ),
            )
          : null,
        revokeState ? h('p', { style: { opacity: 0.8, fontSize: 12 } }, revokeState) : null,
        h('h3', { style: { margin: '16px 0 4px' } }, '我写下的判断'),
        judgementsError ? h('p', { style: { color: '#d94f3d', fontSize: 12 } }, judgementsError) : null,
        !judgements
          ? h('p', { style: { opacity: 0.6, fontSize: 12 } }, '读取中…')
          : judgements.length === 0
            ? h(
                'p',
                { style: { opacity: 0.6, fontSize: 12 } },
                '还没有。用 memory_write 加 subject=self 写一条，这里就会出现。',
              )
            : h(
                'div',
                { style: { marginTop: 4 } },
                judgements.map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      style: {
                        padding: '6px 0',
                        borderBottom: '1px solid rgba(127,127,127,0.12)',
                        fontSize: 12,
                      },
                    },
                    h(
                      'div',
                      { style: { opacity: 0.55, fontSize: 11 } },
                      `${(item.updated_at || '').slice(0, 10)} · ${item.kind}` +
                        (item.superseded_by ? ' · 已被推翻' : ''),
                    ),
                    h('div', null, item.text || item.title),
                  ),
                ),
              ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'memory-hub', order: 120, label: () => '记忆服务' },
          MemoryPage,
        ),
      );
    }

    exports.name = 'dsh-memory-panel';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
