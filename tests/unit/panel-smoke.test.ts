import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Clientside bundle smoke tests: it must register exactly one settings section,
 * talk to the same-origin proxy (Chromium Local Network Access blocks direct
 * 127.0.0.1 fetches), and keep every hint next to the fields it explains.
 *
 * The bundle registers itself through `window.__ModuleLoader__.load`, so the
 * loader has to exist before the dynamic import. Node caches the module, hence
 * the factory is captured once here and shared by both tests.
 */
type Factory = (require: (id: string) => unknown) => {
  name?: string;
  inject?: string[];
  apply: (ctx: unknown) => void;
};

let factory: Factory | undefined;
const storage = new Map<string, string>();
(globalThis as unknown as { window: Record<string, unknown> }).window = {
  __ModuleLoader__: {
    load: (definition: { factory: Factory }) => {
      factory = definition.factory;
    },
  },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
};

const clientUrl = new URL('../../../plugins/dsh-memory-panel/lib/client.js', import.meta.url);
await import(clientUrl.href);
assert.ok(factory, 'client bundle called __ModuleLoader__.load');
const clientFactory: Factory = factory;

/** Minimal React stand-in: elements are plain objects, hooks are inert. */
function makeReact(stateSequence: unknown[] = []): Record<string, unknown> {
  let stateIndex = 0;
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useEffect: () => undefined,
    useState: (initial: unknown) => {
      const override = stateSequence[stateIndex];
      stateIndex += 1;
      const value =
        override !== undefined ? override : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, () => undefined];
    },
  };
}

/** Renders the registered settings component with fake hooks and returns its tree. */
function renderPanel(stateSequence: unknown[]): unknown {
  const moduleExports = clientFactory((id) => (id === 'react' ? makeReact(stateSequence) : undefined)) as {
    apply: (ctx: unknown) => void;
  };
  let component: ((props?: unknown) => unknown) | undefined;
  moduleExports.apply({
    slots: {
      inject: (_slot: string, callback: () => void) => callback(),
      register: (_definition: unknown, render: (props?: unknown) => unknown) => {
        component = render;
        return () => undefined;
      },
    },
  });
  assert.ok(component, 'registered a settings component');
  return (component as (props?: unknown) => unknown)();
}

/** Flattens a fake element tree to text, expanding function components. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!node || typeof node !== 'object') return '';
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  if (typeof element.type === 'function' && element.children !== undefined) {
    const props = { ...(element.props ?? {}), children: element.children };
    return textOf((element.type as (p: unknown) => unknown)(props));
  }
  return textOf(element.children ?? []);
}

const CONFIG_STATE = {
  shortTerm: {
    enabled: true,
    ttlHours: 24,
    maxTtlHours: 168,
    reviewLookbackHours: 72,
    reviewLimit: 30,
    reviewIntervalHours: 20,
  },
  privacy: { sensitiveScope: 'work', sensitiveAudiences: ['main'], ownerAudiences: ['main'] },
  archive: { enabled: false, keepMonths: 12 },
  semantic: {
    enabled: true,
    ready: false,
    reason: 'model missing: /x',
    vectors: 0,
    dim: 512,
    model: 'm.onnx',
    alpha: 0.5,
  },
};

test('panel bundle registers a settings section and uses the proxy paths', () => {
  const react = makeReact();
  const moduleExports = clientFactory((id) => (id === 'react' ? react : undefined)) as {
    name: string;
    inject: string[];
    apply: (ctx: unknown) => void;
  };
  assert.equal(moduleExports.name, 'dsh-memory-panel');
  assert.deepEqual(moduleExports.inject, ['slots']);

  let registered: { name?: string; id?: string } | undefined;
  moduleExports.apply({
    slots: {
      inject: (_slot: string, callback: () => void) => callback(),
      register: (definition: { name?: string; id?: string }) => {
        registered = definition;
        return () => undefined;
      },
    },
  });
  assert.equal(registered?.name, 'settings.section');
  assert.equal(registered?.id, 'memory-hub');

  // The semantic toggle must be wired through the panel: it edits config.semantic,
  // sends it with the config POST, and shows the not-ready reason instead of
  // pretending the feature works.
  const source = readFileSync(clientUrl, 'utf8');
  assert.match(source, /config\.semantic\.enabled/);
  assert.match(source, /semantic: \{ enabled: config\.semantic\.enabled \}/);
  assert.match(source, /pnpm fetch:model/);
  assert.match(source, /config\.semantic\.ready/);
});

test('panel groups each hint with its own section', () => {
  // useState 顺序：health, token, config, configError, saveState, tokens, ...
  const tree = textOf(renderPanel([{ loading: true }, 'token-value', CONFIG_STATE]));

  for (const title of ['短期记忆', '隐私与可见范围', '月度归档', '语义检索']) {
    assert.match(tree, new RegExp(title), `section ${title} rendered`);
  }

  // 每个字段的提示紧跟字段本身（同一组内），而不是堆在页面末尾。
  const order = [
    '隐私与可见范围',
    '敏感记忆 scope',
    '只有带这个 scope 的 token',
    '敏感可见范围',
    '敏感记忆只会写进这些范围',
    'owner 可见范围',
    '对方自己提起某话题时的临时披露范围',
    '逗号分隔。接入微信时把 wx:owner',
    '月度归档',
  ];
  let cursor = -1;
  for (const needle of order) {
    const at = tree.indexOf(needle);
    assert.ok(at > cursor, `“${needle}” 应出现在上一项之后（实际 ${at}，上一项 ${cursor}）`);
    cursor = at;
  }

  // 语义组：勾选框和它的状态说明在同一组，且说明里带着失败原因和下一步。
  assert.match(tree, /已启用但不可用：model missing/);
  assert.match(tree, /pnpm fetch:model/);
});
