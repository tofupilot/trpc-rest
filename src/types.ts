import type { TRPCError } from '@trpc/server';
import type {
  AnyRouter,
  AnyProcedure,
  ProcedureType,
  RootConfig,
  AnyRootTypes,
  TRPC_ERROR_CODE_KEY,
} from '@trpc/server/unstable-core-do-not-import';
import {
  getStatusCodeFromKey,
} from '@trpc/server/unstable-core-do-not-import';

// ─── tRPC re-exports ─────────────────────────────────────────────────

export type { AnyRouter, AnyProcedure, ProcedureType, RootConfig, AnyRootTypes, TRPC_ERROR_CODE_KEY };
export { getStatusCodeFromKey };

/** Narrowed view of AnyProcedure._def – only the fields we read at runtime. */
export interface ProcedureDef {
  type: ProcedureType;
  meta: unknown;
  inputs: unknown[];
  output?: unknown;
}

// ─── Error code → HTTP status ─────────────────────────────────────────
// Typed map from tRPC error code keys to HTTP status codes.
// Uses TRPC_ERROR_CODE_KEY so lookups with `.trpcCode` never return undefined.

export const TRPC_ERROR_CODE_HTTP_STATUS: Record<TRPC_ERROR_CODE_KEY, number> = {
  PARSE_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 408,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_CONTENT: 422,
  PRECONDITION_REQUIRED: 428,
  TOO_MANY_REQUESTS: 429,
  CLIENT_CLOSED_REQUEST: 499,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

// ─── OpenAPI meta ─────────────────────────────────────────────────────

export interface OpenApiMeta {
  openapi?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    tags?: string[];
    summary?: string;
    description?: string;
    successDescription?: string;
    errorResponses?: Record<number, string>;
    protect?: boolean;
    enabled?: boolean;
    contentTypes?: string[];
    deprecated?: boolean;
  } & Record<`x-${string}`, unknown>;
  [key: string]: unknown;
}

// ─── Route table entry ────────────────────────────────────────────────

export interface OpenApiRoute {
  method: string;
  path: string;
  procedurePath: string;
  pathRegex: RegExp;
  pathParams: string[];
  procedure: AnyProcedure;
  meta: OpenApiMeta;
}

// ─── Handler options ──────────────────────────────────────────────────

export interface FetchHandlerOptions<TRouter extends AnyRouter = AnyRouter> {
  router: TRouter;
  endpoint: string;
  req: Request;
  /** Context factory. Receives the Request plus any extra fields the adapter needs. */
  createContext: (opts: { req: Request } & Record<string, unknown>) => Promise<unknown> | unknown;
  responseMeta?: (opts: {
    type: ProcedureType | 'unknown';
    paths: string[] | undefined;
    ctx: unknown;
    data: unknown[];
    errors: unknown[];
    info: unknown;
    eagerGeneration: boolean;
  }) => { status?: number; headers?: Record<string, string> } | undefined;
  onError?: (opts: {
    error: TRPCError;
    type: ProcedureType | 'unknown';
    path: string | undefined;
    input: unknown;
    ctx: unknown;
    req: Request;
  }) => void;
}
