/**
 * One route table shared by the server, the OpenAPI generator, and the
 * contract tests. If a route is registered but missing here (or vice versa),
 * `tests/contract/routes.test.ts` fails.
 */
import type { TSchema } from '@sinclair/typebox';
import {
  TBootstrapRequest,
  TBootstrapResponse,
  TCapabilitiesResponse,
  TConfigSchemaResponse,
  TConfigResponse,
  TConfigUpdateRequest,
  TConfigUpdateResponse,
  TDiscloseRequest,
  TDiscloseResponse,
  TAudienceRequest,
  TAudienceResponse,
  TErrorBody,
  TForgetRequest,
  TForgetResponse,
  TGetRequest,
  TGetResponse,
  THealthResponse,
  TIngestRequest,
  TIngestResponse,
  TRecallRequest,
  TRecallResponse,
  TRecentRequest,
  TRecentResponse,
  TSearchRequest,
  TSearchResponse,
  TTimelineRequest,
  TTimelineResponse,
  TTokenRevokeRequest,
  TTokenRevokeResponse,
  TTokensResponse,
  TWriteRequest,
  TWriteResponse,
} from './schemas.js';

export type HttpMethod = 'GET' | 'POST';

export interface RouteSpec {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  /** `false` only for liveness checks. */
  auth: boolean;
  request?: TSchema;
  response: TSchema;
  /** Error bodies this route may return (besides 500). */
  errors?: number[];
}

export const ROUTE_SPECS: readonly RouteSpec[] = [
  {
    operationId: 'health',
    method: 'GET',
    path: '/v1/health',
    summary: 'Liveness, version, and index statistics.',
    auth: false,
    response: THealthResponse,
  },
  {
    operationId: 'capabilities',
    method: 'GET',
    path: '/v1/capabilities',
    summary: 'Tools, limits, and feature flags (images/documents/semantic/offline are false in v1).',
    auth: true,
    response: TCapabilitiesResponse,
  },
  {
    operationId: 'configSchema',
    method: 'GET',
    path: '/v1/config-schema',
    summary: 'JSON Schema for the DSH settings page (renderer only, not the config source of truth).',
    auth: true,
    response: TConfigSchemaResponse,
  },
  {
    operationId: 'getConfig',
    method: 'GET',
    path: '/v1/config-state',
    summary: 'Read the editable runtime config (root token only; settings page backfill).',
    auth: true,
    response: TConfigResponse,
    errors: [403],
  },
  {
    operationId: 'updateConfig',
    method: 'POST',
    path: '/v1/config',
    summary: 'Update whitelisted runtime config (shortTerm / privacy.autoClassify); root token only.',
    auth: true,
    request: TConfigUpdateRequest,
    response: TConfigUpdateResponse,
    errors: [400, 403],
  },
  {
    operationId: 'getTokens',
    method: 'GET',
    path: '/v1/tokens',
    summary: 'List token metadata (root only; hashes are never returned).',
    auth: true,
    response: TTokensResponse,
    errors: [403],
  },
  {
    operationId: 'revokeToken',
    method: 'POST',
    path: '/v1/tokens/revoke',
    summary: 'Revoke one token by id (root only). Issuing stays in the admin CLI.',
    auth: true,
    request: TTokenRevokeRequest,
    response: TTokenRevokeResponse,
    errors: [403, 404],
  },
  {
    operationId: 'bootstrap',
    method: 'POST',
    path: '/v1/bootstrap',
    summary: 'Identity, audience face, and recent titles for session start.',
    auth: true,
    request: TBootstrapRequest,
    response: TBootstrapResponse,
  },
  {
    operationId: 'search',
    method: 'POST',
    path: '/v1/search',
    summary: 'Keyword search over visible chunks (default k=5, max 10).',
    auth: true,
    request: TSearchRequest,
    response: TSearchResponse,
    errors: [400],
  },
  {
    operationId: 'get',
    method: 'POST',
    path: '/v1/get',
    summary: 'Fetch one chunk by id; 404 when absent or not visible in this scene.',
    auth: true,
    request: TGetRequest,
    response: TGetResponse,
    errors: [404],
  },
  {
    operationId: 'recent',
    method: 'POST',
    path: '/v1/recent',
    summary: 'Most recently updated visible memories.',
    auth: true,
    request: TRecentRequest,
    response: TRecentResponse,
  },
  {
    operationId: 'recall',
    method: 'POST',
    path: '/v1/recall',
    summary: 'Keyword recall from recent chat messages; returns 2–3 short snippets.',
    auth: true,
    request: TRecallRequest,
    response: TRecallResponse,
  },
  {
    operationId: 'timeline',
    method: 'POST',
    path: '/v1/timeline',
    summary: 'Documents in time order, grouped by month — "what was going on back then" instead of similarity.',
    auth: true,
    request: TTimelineRequest,
    response: TTimelineResponse,
  },
  {
    operationId: 'disclose',
    method: 'POST',
    path: '/v1/disclose',
    summary:
      'Cross-scene disclosure: recent messages of ONE group, for a requester the bridge verified as a member (needs the disclose:group scope).',
    auth: true,
    request: TDiscloseRequest,
    response: TDiscloseResponse,
    errors: [400, 403],
  },
  {
    operationId: 'write',
    method: 'POST',
    path: '/v1/write',
    summary: 'Append one fact to facts/YYYY-MM.jsonl and index it.',
    auth: true,
    request: TWriteRequest,
    response: TWriteResponse,
    errors: [400, 409, 413],
  },
  {
    operationId: 'forget',
    method: 'POST',
    path: '/v1/forget',
    summary: 'Forget one fact by id (or idempotency key); the JSONL keeps a tombstone.',
    auth: true,
    request: TForgetRequest,
    response: TForgetResponse,
    errors: [400, 403, 404],
  },
  {
    operationId: 'ingest',
    method: 'POST',
    path: '/v1/ingest',
    summary: 'Store ordinary chat messages as short-term memories with a TTL (forgetting curve).',
    auth: true,
    request: TIngestRequest,
    response: TIngestResponse,
    errors: [400, 413],
  },
  {
    operationId: 'audience',
    method: 'POST',
    path: '/v1/audience',
    summary: 'Read the audience card for a scene (owner-only in practice).',
    auth: true,
    request: TAudienceRequest,
    response: TAudienceResponse,
    errors: [404],
  },
];

export function routeByOperationId(id: string): RouteSpec {
  const found = ROUTE_SPECS.find((r) => r.operationId === id);
  if (!found) throw new Error(`unknown operationId: ${id}`);
  return found;
}

/**
 * Minimal OpenAPI 3.1 document. TypeBox schemas are already JSON Schema
 * (draft 2020-12 style), so they are embedded as-is.
 */
export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {
    ErrorBody: TErrorBody,
  };

  for (const route of ROUTE_SPECS) {
    const pathItem = (paths[route.path] ??= {});
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: ['memory'],
      responses: {
        '200': {
          description: 'Success',
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${route.operationId}Response` } },
          },
        },
        ...Object.fromEntries(
          (route.errors ?? []).map((status) => [
            String(status),
            {
              description: 'Error',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } },
              },
            },
          ]),
        ),
        '401': { description: 'Missing or invalid token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
        '500': { description: 'Internal error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      },
    };
    if (route.request) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.operationId}Request` } } },
      };
      schemas[`${route.operationId}Request`] = route.request;
    }
    schemas[`${route.operationId}Response`] = route.response;
    if (route.auth) {
      operation.security = [{ bearerAuth: [] }];
    }
    pathItem[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'memory-hub',
      version,
      description: 'Local-first, scope-filtered text memory for DSH and the QQ bridge.',
    },
    servers: [
      { url: 'http://127.0.0.1:8787', description: 'loopback' },
      { url: 'http://172.22.0.10:8787', description: 'ZeroTier VLAN' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'msv1_<id>_<secret>' },
      },
      schemas,
    },
    paths,
  };
}
