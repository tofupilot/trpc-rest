import { TRPCError } from '@trpc/server';
import {
  getErrorShape,
  getHTTPStatusCodeFromError,
  type TRPCRequestInfo } from
'@trpc/server/unstable-core-do-not-import';
import type {
  AnyRouter,
  AnyProcedure,
  ProcedureType,
  OpenApiMeta,
  OpenApiRoute,
  FetchHandlerOptions,
  ProcedureDef } from
'./types';
import { TRPC_ERROR_CODE_HTTP_STATUS } from './types';
import {
  pathToRegex,
  extractPathParams,
  extractQueryParams,
  normalizePath,
  hasBodyFields,
  isVoidLike,
  unwrapZodType,
  unwrapShallow,
  coerceQueryParams,
  isZodObject,
  mergeInputs } from
'./params';
import type { ZodTypeAny } from 'zod';
import { z } from "zod";

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// ─── Procedure access helpers ─────────────────────────────────────────

function getProcedureDef(procedure: AnyProcedure): ProcedureDef {
  return procedure._def as unknown as ProcedureDef;
}

function getInputOutputParsers(procedure: AnyProcedure): {
  inputParser: ZodTypeAny | undefined;
  outputParser: ZodTypeAny | undefined;
} {
  const def = getProcedureDef(procedure);
  const inputs = def.inputs as ZodTypeAny[];
  const output = def.output as ZodTypeAny | undefined;

  return { inputParser: mergeInputs(inputs) as ZodTypeAny | undefined, outputParser: output };
}

// ─── Route table ──────────────────────────────────────────────────────

function buildRouteTable(router: AnyRouter, endpoint: string): OpenApiRoute[] {
  const routes: OpenApiRoute[] = [];
  const procedures = router._def.procedures as Record<string, AnyProcedure>;

  for (const [dotPath, procedure] of Object.entries(procedures)) {
    if (!procedure || typeof procedure !== 'function') continue;

    const def = getProcedureDef(procedure);
    if (!def.meta || typeof def.meta !== 'object') continue;

    const meta = def.meta as OpenApiMeta;
    if (!meta.openapi?.path || !meta.openapi?.method) continue;
    if (meta.openapi.enabled === false) continue;

    const path = normalizePath(meta.openapi.path);
    const fullPath = `${endpoint}${path}`;
    const { regex, params } = pathToRegex(fullPath);
    routes.push({
      method: meta.openapi.method,
      path: fullPath,
      procedurePath: dotPath,
      pathRegex: regex,
      pathParams: params,
      procedure,
      meta
    });
  }

  return routes;
}

function matchRoute(
routes: OpenApiRoute[],
method: string,
pathname: string)
: {route: OpenApiRoute;pathParams: Record<string, string>;} | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = extractPathParams(pathname, route.pathRegex);
    if (params) return { route, pathParams: params };
  }
  return null;
}

// ─── Body parsing ─────────────────────────────────────────────────────

async function parseBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const text = await req.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new TRPCError({
        code: 'PARSE_ERROR',
        message: 'Failed to parse request body',
        cause: cause instanceof Error ? cause : undefined
      });
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await req.text());
    const data: Record<string, string | string[]> = {};
    for (const key of params.keys()) {
      const values = params.getAll(key);
      data[key] = values.length === 1 ? values[0]! : values;
    }
    return data;
  }

  throw new TRPCError({
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: `Unsupported content-type "${contentType || '(empty)'}"`
  });
}

// ─── Error conversion ─────────────────────────────────────────────────

function getErrorFromUnknown(cause: unknown): TRPCError {
  if (cause instanceof TRPCError) return cause;
  // Cross-realm TRPCError detection: validate .code against known tRPC error codes
  if (
    cause instanceof Error &&
    'code' in cause &&
    typeof (cause as TRPCError).code === 'string' &&
    (cause as TRPCError).code in TRPC_ERROR_CODE_HTTP_STATUS
  ) {
    return cause as TRPCError;
  }

  const errorCause = cause instanceof Error ? cause : undefined;
  const error = new TRPCError({
    message: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
    cause: errorCause
  });
  if (errorCause?.stack) error.stack = errorCause.stack;
  return error;
}

// ─── Route cache ─────────────────────────────────────────────────────
// Cache route tables by router+endpoint to avoid rebuilding per request.

const routeCache = new WeakMap<AnyRouter, Map<string, OpenApiRoute[]>>();

function getRoutes(router: AnyRouter, endpoint: string): OpenApiRoute[] {
  let endpointMap = routeCache.get(router);
  if (!endpointMap) {
    endpointMap = new Map();
    routeCache.set(router, endpointMap);
  }
  let routes = endpointMap.get(endpoint);
  if (!routes) {
    routes = buildRouteTable(router, endpoint);
    endpointMap.set(endpoint, routes);
  }
  return routes;
}

// ─── Handler ──────────────────────────────────────────────────────────

/**
 * Handle an incoming HTTP request as a tRPC OpenAPI call.
 *
 * Routes the request to the matching tRPC procedure based on OpenAPI metadata,
 * runs the full middleware chain via `createCaller`, and returns a JSON `Response`.
 *
 * @param opts - Handler configuration including the router, endpoint prefix, request, and context factory.
 * @returns A `Response` with JSON body (data on success, error shape on failure).
 *
 * @example
 * ```ts
 * const response = await createOpenApiFetchHandler({
 *   router: appRouter,
 *   endpoint: '/api',
 *   req: request,
 *   createContext: ({ req }) => createTRPCContext(req),
 * });
 * ```
 */
export async function createOpenApiFetchHandler(
opts: FetchHandlerOptions)
: Promise<Response> {
  const router = opts.router;
  const routes = getRoutes(router, opts.endpoint);

  const url = new URL(opts.req.url);
  const method = opts.req.method.toUpperCase();
  const pathname = normalizePath(url.pathname);
  const match = matchRoute(routes, method, pathname);

  let input: unknown = undefined;
  let ctx: unknown = undefined;
  let data: unknown = undefined;

  // HEAD without a route match: check if ANY method matches this path (warmup/health probes)
  if (!match && method === 'HEAD') {
    const anyMethodMatch = routes.some((route) => {
      const params = extractPathParams(pathname, route.pathRegex);
      return params !== null;
    });
    if (anyMethodMatch) return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  }

  if (!match) {
    return Response.json({ message: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const { route, pathParams } = match;
  const def = getProcedureDef(route.procedure);

  try {
    const { inputParser } = getInputOutputParsers(route.procedure);
    const unwrapped = inputParser ? unwrapZodType(inputParser, true) : undefined;

    const voidLike = !unwrapped || isVoidLike(unwrapped);
    const useBody = BODY_METHODS.has(method);
    const bodyNeeded = !voidLike && hasBodyFields(unwrapped, pathParams);

    // Content-type check (with built-in fix for path-only params)
    if (useBody && bodyNeeded) {
      const contentType = opts.req.headers.get('content-type') ?? '';
      if (!contentType.startsWith('application/json') && !contentType.includes('application/x-www-form-urlencoded')) {
        throw new TRPCError({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: contentType ?
          `Unsupported content-type "${contentType}"` :
          'Missing content-type header'
        });
      }
    }

    // Build input
    if (!voidLike) {
      if (useBody && bodyNeeded) {
        input = { ...((await parseBody(opts.req)) as Record<string, unknown> | undefined), ...pathParams };
      } else {
        input = { ...extractQueryParams(url), ...pathParams };
      }

      // Coerce string query params to correct types (without mutating the schema)
      if (unwrapped && isZodObject(unwrapped) && !useBody) {
        const inputRecord = input as Record<string, unknown>;
        for (const [key, shapeSchema] of Object.entries(unwrapped.shape)) {
          const unwrappedField = unwrapShallow(shapeSchema as z.ZodType);
          if (unwrappedField instanceof z.ZodArray && inputRecord[key] !== undefined && !Array.isArray(inputRecord[key])) {
            inputRecord[key] = [inputRecord[key]];
          }
        }
        input = coerceQueryParams(unwrapped, inputRecord);
      }
    }

    // Context
    const info: TRPCRequestInfo = {
      isBatchCall: false,
      accept: null,
      calls: [],
      type: def.type,
      connectionParams: null,
      signal: opts.req.signal,
      url
    };
    ctx = await opts.createContext({ req: opts.req, res: undefined, info });

    // Call via createCaller — runs full middleware chain + errorFormatter
    const caller = router.createCaller(ctx);
    const segments = route.procedurePath.split('.');
    const procedureFn = segments.reduce<unknown>(
      (acc, curr) => (acc as Record<string, unknown>)[curr],
      caller
    ) as (input: unknown) => Promise<unknown>;

    data = await procedureFn(input);

    // Response
    const meta = opts.responseMeta?.({
      type: def.type,
      paths: [route.procedurePath],
      ctx,
      data: [data],
      errors: [],
      info,
      eagerGeneration: true
    });

    const statusCode = meta?.status ?? 200;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (meta?.headers) {
      for (const [key, value] of Object.entries(meta.headers)) {
        if (value !== undefined) headers.set(key, value);
      }
    }

    return new Response(JSON.stringify(data), { status: statusCode, headers });
  } catch (cause) {
    const error = getErrorFromUnknown(cause);

    opts.onError?.({
      error,
      type: def.type ?? 'unknown',
      path: route.procedurePath,
      input,
      ctx,
      req: opts.req
    });

    const meta = opts.responseMeta?.({
      type: def.type ?? 'unknown',
      paths: [route.procedurePath],
      ctx,
      data: [data],
      errors: [error],
      info: undefined,
      eagerGeneration: true
    });

    // Format error through tRPC's errorFormatter
    const config = router._def._config;
    const errorShape = getErrorShape({
      config,
      error,
      type: def.type ?? 'unknown',
      path: route.procedurePath,
      input,
      ctx
    });

    const isInputValidationError =
    error.code === 'BAD_REQUEST' &&
    error.cause instanceof Error &&
    'issues' in error.cause &&
    Array.isArray((error.cause as Record<string, unknown>).issues);

    const statusCode = meta?.status ?? getHTTPStatusCodeFromError(error);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (meta?.headers) {
      for (const [key, value] of Object.entries(meta.headers)) {
        if (value !== undefined) headers.set(key, value);
      }
    }

    // Spread errorShape but strip internal fields that could leak stack traces or paths
    const { data: _data, ...safeShape } = (errorShape ?? {}) as Record<string, unknown> & { data?: unknown };
    const body = {
      ...safeShape,
      message: isInputValidationError ?
      'Input validation failed' :
      safeShape?.message ?? error.message ?? 'An error occurred',
      code: error.code,
      issues: isInputValidationError ?
      (error.cause as Error & {issues: unknown[];}).issues :
      undefined
    };

    return new Response(JSON.stringify(body), { status: statusCode, headers });
  }
}