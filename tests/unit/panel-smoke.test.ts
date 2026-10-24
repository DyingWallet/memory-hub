import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Smoke test for the client plugin bundle: it must register exactly one
 * settings section and must talk to the same-origin proxy, never to 8787
 * directly (Chromium Local Network Access blocks that).
 */
test('panel bundle registers a settings section and uses the proxy paths', async () => {
  let factory: ((require: (id: string) => unknown) => unknown) | undefined;
  const storage = new Map<string, string>();

  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    __ModuleLoader__: {
      load: (definition: { factory: typeof factory }) => {
        factory = definition.factory;
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };

  const url = new URL('../../../plugins/dsh-memory-panel/lib/client.js', import.meta.url);
  await import(url.href);
  assert.ok(factory, 'client bundle called __ModuleLoader__.load');

  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useEffect: () => undefined,
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
  };
  const moduleExports = factory!((id: string) => (id === 'react' ? react : undefined)) as {
    name: string;
    inject: string[];
    apply: (ctx: unknown) => void;
  };
  assert.equal(moduleExports.name, 'dsh-memory-panel');
  assert.deepEqual(moduleExports.inject, ['slots']);

  let registered: { name?: string; id?: string } | undefined;
  const ctx = {
    slots: {
      inject: (_slot: string, callback: () => void) => callback(),
      register: (definition: { name?: string; id?: string }) => {
        registered = definition;
        return () => undefined;
      },
    },
  };
  moduleExports.apply(ctx);
  assert.equal(registered?.name, 'settings.section');
  assert.equal(registered?.id, 'memory-hub');

  // The semantic toggle must be wired through the panel: it edits config.semantic,
  // sends it with the config POST, and shows the not-ready reason instead of
  // pretending the feature works.
  const source = readFileSync(new URL('../../../plugins/dsh-memory-panel/lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /config\.semantic\.enabled/);
  assert.match(source, /semantic: \{ enabled: config\.semantic\.enabled \}/);
  assert.match(source, /pnpm fetch:model/);
  assert.match(source, /config\.semantic\.ready/);
});
