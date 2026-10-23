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

    function Field({ label, children }) {
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' } },
        h('span', { style: { width: 150, opacity: 0.8 } }, label),
        children,
      );
    }

    const inputStyle = { width: 90, padding: '2px 6px' };

    function NumberField({ label, value, onChange, min, max, step }) {
      return h(
        Field,
        { label },
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

      useEffect(() => {
        const authToken = token.trim();
        if (!authToken) {
          setConfig(null);
          return undefined;
        }
        let alive = true;
        setConfigError('');
        fetch(PATH_CONFIG_STATE, {
          cache: 'no-store',
          headers: { authorization: 'Bearer ' + authToken },
        })
          .then(async (response) => {
            if (response.status === 401) throw new Error('令牌无效（HTTP 401）——检查是否有尾随空格/换行');
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
      }, [token]);

      useEffect(() => {
        const authToken = token.trim();
        if (!authToken) {
          setTokens(null);
          return undefined;
        }
        let alive = true;
        setTokenError('');
        fetch(PATH_TOKENS, { cache: 'no-store', headers: { authorization: 'Bearer ' + authToken } })
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
      }, [token, revokeState]);

      const revoke = async (id) => {
        if (!window.confirm('吊销 token ' + id + '？吊销后立即失效。')) return;
        setRevokeState('吊销中…');
        try {
          const response = await fetch(PATH_REVOKE, {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token.trim(), 'content-type': 'application/json' },
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
            headers: { authorization: 'Bearer ' + token.trim(), 'content-type': 'application/json' },
            body: JSON.stringify({
              shortTerm: { ...config.shortTerm },
              privacy: {
                sensitiveScope: config.privacy.sensitiveScope,
                sensitiveAudiences: config.privacy.sensitiveAudiences,
                ownerAudiences: config.privacy.ownerAudiences,
              },
              archive: { ...config.archive },
            }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error((body && body.error && body.error.message) || 'HTTP ' + response.status);
          setSaveState('已保存：' + (body.applied || []).join(', '));
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
          { label: 'root 令牌' },
          h('input', {
            type: 'password',
            value: token,
            placeholder: '~/.dsh/memory-token',
            style: { width: 260, padding: '2px 6px' },
            onChange: (event) => saveToken(event.target.value),
          }),
        ),
        configError ? h('p', { style: { color: '#d94f3d' } }, configError) : null,
        h(
          'p',
          { style: { opacity: 0.6, fontSize: 12, margin: '0 0 4px' } },
          '已输入 ' + token.trim().length + ' 字符（会自动去掉首尾空白）',
        ),
        !config
          ? h('p', { style: { opacity: 0.6, fontSize: 12 } }, '填入 root 令牌后可读取/修改配置。')
          : h(
              'div',
              null,
              h(NumberField, {
                label: '短期 TTL（小时）',
                value: config.shortTerm.ttlHours,
                min: 0.1,
                max: 720,
                step: 0.1,
                onChange: (value) => patch('shortTerm', 'ttlHours', value),
              }),
              h(NumberField, {
                label: 'TTL 上限（小时）',
                value: config.shortTerm.maxTtlHours,
                min: 0.1,
                max: 8760,
                step: 0.1,
                onChange: (value) => patch('shortTerm', 'maxTtlHours', value),
              }),
              h(NumberField, {
                label: '回顾回看（小时）',
                value: config.shortTerm.reviewLookbackHours,
                min: 1,
                max: 336,
                onChange: (value) => patch('shortTerm', 'reviewLookbackHours', value),
              }),
              h(NumberField, {
                label: '回顾条数上限',
                value: config.shortTerm.reviewLimit,
                min: 1,
                max: 100,
                onChange: (value) => patch('shortTerm', 'reviewLimit', value),
              }),
              h(NumberField, {
                label: '回顾间隔（小时）',
                value: config.shortTerm.reviewIntervalHours,
                min: 1,
                max: 168,
                onChange: (value) => patch('shortTerm', 'reviewIntervalHours', value),
              }),
              h(
                Field,
                { label: '敏感记忆 scope' },
                h('input', {
                  type: 'text',
                  value: config.privacy.sensitiveScope,
                  style: { width: 200, padding: '2px 6px' },
                  onChange: (event) => patch('privacy', 'sensitiveScope', event.target.value.trim()),
                }),
              ),
              h(
                Field,
                { label: '敏感可见范围' },
                h('input', {
                  type: 'text',
                  value: (config.privacy.sensitiveAudiences || []).join(', '),
                  style: { width: 280, padding: '2px 6px' },
                  onChange: (event) => patch('privacy', 'sensitiveAudiences', splitList(event.target.value)),
                }),
              ),
              h(
                Field,
                { label: 'owner 可见范围' },
                h('input', {
                  type: 'text',
                  value: (config.privacy.ownerAudiences || []).join(', '),
                  style: { width: 280, padding: '2px 6px' },
                  onChange: (event) => patch('privacy', 'ownerAudiences', splitList(event.target.value)),
                }),
              ),
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
                onChange: (value) => patch('archive', 'keepMonths', value),
              }),
              h(
                'p',
                { style: { opacity: 0.6, fontSize: 12, margin: '0 0 8px' } },
                '逗号分隔。敏感记忆只会写进「敏感可见范围」；「owner 可见范围」用于对方自己提起时的临时披露。接入微信时把 wx:owner 加进这两个列表即可。',
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
          ? h('p', { style: { opacity: 0.6, fontSize: 12 } }, '填入 root 令牌后可查看。')
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
