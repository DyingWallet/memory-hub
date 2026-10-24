import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer, SERVER_INSTRUCTIONS, type MemoryApi } from '@memsvc/adapter-dsh/mcp-server';
import type { BootstrapResponse, SearchResponse } from '@memsvc/protocol';

const bootstrapResponse: BootstrapResponse = {
  identity: '助手（潮助手的助手）',
  audience: { id: 'main', face: '主会话' },
  recent: [{ id: 'doc:1', title: '桌宠接入', kind: 'knowledge' }],
  self: [{ id: 'f_self_1', title: '我认为记忆该能记判断', kind: 'stance' }],
  counts: { docs: 3, facts: 2 },
  instructions: '先 memory_search',
};

const searchResponse: SearchResponse = {
  query: '桌宠',
  weak: false,
  scanned: 1,
  results: [
    {
      id: 'doc:1#0',
      title: '桌宠接入',
      kind: 'knowledge',
      render: { type: 'text', text: 'PC2005 的插件开放 HTTP API。' },
      path: '50-knowledge/pet.md',
      updated_at: '2026-10-23T00:00:00.000Z',
      score: 1.5,
    },
  ],
};

const fakeApi: MemoryApi = {
  async bootstrap() {
    return bootstrapResponse;
  },
  async search(query) {
    return { ...searchResponse, query };
  },
  async get(id) {
    return { memory: id === 'doc:1#0' ? (searchResponse.results[0] ?? null) : null };
  },
  async recent() {
    return { results: searchResponse.results };
  },
  async recall(messages) {
    return { keywords: ['桌宠'], results: messages.length > 0 ? searchResponse.results : [] };
  },
  async write(record) {
    return { id: `f_test_${record.kind}`, indexed: true, duplicate: false };
  },
  async review() {
    return { should_review: false, counts: { short: 0, reviewable: 0 }, results: [] };
  },
  async persist(ids) {
    return { persisted: ids };
  },
  async capabilities() {
    return {
      protocol: 'v1',
      version: '0.1.0',
      tools: ['memory_search'],
      features: { images: false, documents: false, semantic: false, offline: false, short_term: true },
      limits: {
        search_default_k: 5,
        search_max_k: 10,
        search_default_chars: 600,
        recall_max_messages: 8,
        write_max_chars: 8000,
      },
    };
  },
};

let client: Client;

before(async () => {
  const server = createMemoryMcpServer(fakeApi, { writeEnabled: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
});

test('server advertises the memory usage instructions', async () => {
  const instructions = client.getInstructions();
  assert.equal(instructions, SERVER_INSTRUCTIONS);
});

test('all v1 tools are registered with descriptions', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'memory_bootstrap',
    'memory_call',
    'memory_get',
    'memory_persist',
    'memory_recall',
    'memory_recent',
    'memory_review',
    'memory_search',
    'memory_write',
  ]);
  for (const tool of tools) assert.ok((tool.description ?? '').length > 5, tool.name);
});

test('memory_search forwards the query and returns JSON text', async () => {
  const result = await client.callTool({ name: 'memory_search', arguments: { query: '桌宠', k: 3 } });
  const content = (result.content as { type: string; text: string }[])[0];
  assert.equal(content?.type, 'text');
  const payload = JSON.parse(content?.text ?? '{}') as SearchResponse;
  assert.equal(payload.query, '桌宠');
  assert.equal(payload.results[0]?.title, '桌宠接入');
});

test('memory_bootstrap includes the rendered block', async () => {
  const result = await client.callTool({ name: 'memory_bootstrap', arguments: {} });
  const payload = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as Record<string, unknown>;
  assert.match(String(payload.block), /【记忆】/);
  assert.match(String(payload.block), /memory_search/);
});

test('memory_get returns null memory for unknown ids', async () => {
  const result = await client.callTool({ name: 'memory_get', arguments: { id: 'nope' } });
  const payload = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as { memory: unknown };
  assert.equal(payload.memory, null);
});

test('memory_write is refused when disabled', async () => {
  const server = createMemoryMcpServer(fakeApi, { writeEnabled: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const disabledClient = new Client({ name: 'disabled', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), disabledClient.connect(clientTransport)]);
  const result = await disabledClient.callTool({
    name: 'memory_write',
    arguments: { kind: 'note', text: '不应写入' },
  });
  assert.equal(result.isError, true);
  await disabledClient.close();
});

test('memory_call rejects unknown ops', async () => {
  const result = await client.callTool({ name: 'memory_call', arguments: { op: 'delete_everything' } });
  assert.equal(result.isError, true);
});
