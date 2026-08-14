import type { ApiError, ApiSuccess, ErrorCode } from '@billing/types';

/**
 * Typed fetch wrapper for /api/v1.
 *
 * Always sends credentials so the HttpOnly session cookie travels with the
 * request; never attaches a token from JS storage (Frontend Spec §37).
 */

const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1`;

export class ApiRequestError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly details?: Array<{ field: string; message: string }>;

  constructor(status: number, body: ApiError) {
    super(body.error.message);
    this.name = 'ApiRequestError';
    this.code = body.error.code;
    this.status = status;
    this.requestId = body.requestId;
    this.details = body.error.details;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiRequestError(response.status, parsed as ApiError);
  }

  return (parsed as ApiSuccess<T>).data;
}
