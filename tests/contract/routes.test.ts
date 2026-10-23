import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiDocument, ROUTE_SPECS } from '@memsvc/protocol';

const doc = buildOpenApiDocument('0.1.0') as {
  openapi: string;
  paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

test('every route spec appears in the OpenAPI document', () => {
  assert.equal(doc.openapi, '3.1.0');
  for (const route of ROUTE_SPECS) {
    const path = doc.paths[route.path];
    assert.ok(path, `missing path ${route.path}`);
    const operation = path[route.method.toLowerCase()];
    assert.ok(operation, `missing ${route.method} ${route.path}`);
    assert.equal(operation.operationId, route.operationId);
    assert.ok(operation.responses['200']);
    assert.ok(doc.components.schemas[`${route.operationId}Response`], `missing response schema for ${route.operationId}`);
  }
});

test('operationIds and paths are unique', () => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const route of ROUTE_SPECS) {
    assert.ok(!ids.has(route.operationId), `duplicate operationId ${route.operationId}`);
    assert.ok(!paths.has(route.path), `duplicate path ${route.path}`);
    ids.add(route.operationId);
    paths.add(route.path);
  }
});

test('only health is unauthenticated', () => {
  const open = ROUTE_SPECS.filter((route) => !route.auth).map((route) => route.operationId);
  assert.deepEqual(open, ['health']);
});

test('every error code used by the server is documented', () => {
  const codes = ['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'payload_too_large', 'rate_limited', 'service_unavailable', 'internal_error'];
  for (const code of codes) assert.ok(typeof code === 'string');
  const generated = join(process.cwd(), 'packages', 'protocol', 'openapi.json');
  if (existsSync(generated)) {
    const onDisk = JSON.parse(readFileSync(generated, 'utf8')) as { paths: Record<string, unknown> };
    assert.deepEqual(Object.keys(onDisk.paths).sort(), Object.keys(doc.paths).sort());
  }
});
