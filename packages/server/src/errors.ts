import type { ErrorCode } from '@memsvc/protocol';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errors = {
  invalid: (message: string, details?: Record<string, unknown>) => new ApiError(400, 'invalid_request', message, details),
  unauthorized: (message = 'missing or invalid bearer token') => new ApiError(401, 'unauthorized', message),
  forbidden: (message: string) => new ApiError(403, 'forbidden', message),
  notFound: (message = 'not found') => new ApiError(404, 'not_found', message),
  conflict: (message: string) => new ApiError(409, 'conflict', message),
  tooLarge: (message: string) => new ApiError(413, 'payload_too_large', message),
  unavailable: (message: string) => new ApiError(503, 'service_unavailable', message),
};
