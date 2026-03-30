import { z } from 'zod';
import type { ZodTypeAny, ZodObject, ZodRawShape } from 'zod';
import { createDocument, createSchema } from 'zod-openapi';
import type { AnyRouter, AnyProcedure, OpenApiMeta, ProcedureDef } from './types';
import { isZodObject, mergeInputs, unwrapShallow } from './params';


// ─── Types ────────────────────────────────────────────────────────────

export interface OpenApiDocument {
  openapi: string;
  info: {title: string;description?: string;version: string;};
  servers?: Array<{url: string;description?: string;}>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  tags?: Array<{name: string;description?: string;}>;
  security?: Array<Record<string, string[]>>;
  externalDocs?: {url: string;description?: string;};
}

/** Maps HTTP status codes to reusable error schema names. */
export interface ErrorSchemaConfig {
  /** Map of HTTP status code → component schema ref name, e.g. { 400: 'ErrorBADREQUEST' } */
  schemas: Record<number, string>;
  /** If true, auto-add 401 Unauthorized to every operation that doesn't have one. */
  autoAdd401?: boolean;
}

export interface GenerateOptions {
  title: string;
  description?: string;
  version: string;
  baseUrl: string;
  tags?: string[];
  docsUrl?: string;
  securitySchemes?: Record<string, unknown>;
  filter?: (opts: {path: string[];metadata: OpenApiMeta;}) => boolean;
  /** Return OpenAPI extensions (x-*) to merge into each operation object. */
  extensions?: (opts: {
    meta: OpenApiMeta;
    procedurePath: string[];
    operationId: string;
  }) => Record<string, unknown> | undefined;
  /**
   * Error response configuration. When provided, the generator will:
   * 1. Replace inline error response schemas with $ref to component schemas
   * 2. Optionally auto-add 401 Unauthorized to all operations
   */
  errorSchemas?: ErrorSchemaConfig;
}

// ─── Procedure collection ─────────────────────────────────────────────

interface CollectedProcedure {
  trpcPath: string[];
  meta: OpenApiMeta;
  inputParser: ZodTypeAny | undefined;
  outputParser: ZodTypeAny | undefined;
}

function collectProcedures(
router: AnyRouter,
filter?: GenerateOptions['filter'])
: CollectedProcedure[] {
  const results: CollectedProcedure[] = [];
  const procedures = router._def.procedures as Record<string, AnyProcedure>;

  for (const [dotPath, procedure] of Object.entries(procedures)) {
    if (!procedure || typeof procedure !== 'function') continue;

    const def = procedure._def as unknown as ProcedureDef;
    if (!def.meta || typeof def.meta !== 'object') continue;

    const meta = def.meta as OpenApiMeta;
    const trpcPath = dotPath.split('.');

    if (filter && !filter({ path: trpcPath, metadata: meta })) continue;
    if (!meta.openapi?.path || !meta.openapi?.method) continue;
    if (meta.openapi.enabled === false) continue;

    const inputs = def.inputs as ZodTypeAny[];
    const inputParser = mergeInputs(inputs) as ZodTypeAny | undefined;
    const outputParser = def.output as ZodTypeAny | undefined;

    results.push({ trpcPath, meta, inputParser, outputParser });
  }

  return results;
}

// ─── Path helpers ─────────────────────────────────────────────────────

function getPathParams(path: string): string[] {
  const params: string[] = [];
  path.replace(/\{([^}]+)\}/g, (_, param: string) => {
    params.push(param);
    return '';
  });
  return params;
}

function excludePathParamsFromSchema(
schema: ZodTypeAny,
pathParams: string[])
: ZodTypeAny {
  if (!isZodObject(schema) || pathParams.length === 0) return schema;

  const omitKeys: Record<string, true> = {};
  for (const param of pathParams) {
    omitKeys[param] = true;
  }

  try {
    return (schema as ZodObject<ZodRawShape>).omit(omitKeys) as ZodTypeAny;
  } catch {
    return schema;
  }
}

// ─── Generator ────────────────────────────────────────────────────────

/**
 * Generate an OpenAPI 3.1.0 document from a tRPC router.
 *
 * Scans all procedures for `openapi` metadata and produces a complete OpenAPI spec
 * including paths, parameters, request bodies, responses, and security.
 *
 * Uses `zod-openapi`'s `createDocument` for Zod → JSON Schema conversion, which handles
 * transforms, $ref deduplication, and `.meta()` annotations.
 *
 * @param router - The tRPC router to generate docs from.
 * @param opts - Generation options (title, version, baseUrl, securitySchemes, etc.).
 * @returns An OpenAPI 3.1.0 document object.
 *
 * @example
 * ```ts
 * const doc = generateOpenApiDocument(appRouter, {
 *   title: 'My API',
 *   version: '1.0.0',
 *   baseUrl: 'https://api.example.com',
 * });
 * ```
 */
export function generateOpenApiDocument(
router: AnyRouter,
opts: GenerateOptions)
: OpenApiDocument {
  const procedures = collectProcedures(router, opts.filter);

  // Build the paths object with Zod schemas (not JSON Schema).
  // createDocument will convert them.
  const securitySchemes = opts.securitySchemes ?? {};
  const zodPaths: Record<string, Record<string, unknown>> = {};

  // Track procedure metadata for post-processing extensions
  const procedureMeta: Array<{
    pathKey: string;
    method: string;
    meta: OpenApiMeta;
    trpcPath: string[];
    operationId: string;
  }> = [];

  for (const { trpcPath, meta, inputParser, outputParser } of procedures) {
    const openapi = meta.openapi!;
    const method = openapi.method.toLowerCase();
    const pathKey = openapi.path;
    const pathParams = getPathParams(openapi.path);
    const operationId = trpcPath.join('-');

    if (!zodPaths[pathKey]) zodPaths[pathKey] = {};

    // Build parameters (path + query)
    const parameters: Record<string, unknown>[] = [];
    for (const param of pathParams) {
      // Extract description from the Zod field's .meta() metadata if available
      let description: string | undefined;
      if (inputParser && isZodObject(inputParser)) {
        const fieldSchema = inputParser.shape[param] as ZodTypeAny | undefined;
        if (fieldSchema) {
          description = fieldSchema.description;
        }
      }
      parameters.push({
        name: param,
        in: 'path' as const,
        required: true,
        schema: { type: 'string' as const },
        ...(description ? { description } : {})
      });
    }

    const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(openapi.method);
    if (!isBodyMethod && inputParser && isZodObject(inputParser)) {
      for (const [key, fieldSchema] of Object.entries(inputParser.shape)) {
        if (pathParams.includes(key)) continue;
        const isOptional =
          fieldSchema instanceof z.ZodOptional ||
          fieldSchema instanceof z.ZodDefault ||
          (fieldSchema instanceof z.ZodNullable && fieldSchema.unwrap() instanceof z.ZodOptional);
        let jsonSchema: Record<string, unknown> = { type: 'string' };
        try {
          const result = createSchema(fieldSchema);
          jsonSchema = result.schema as Record<string, unknown>;
        } catch (e) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[trpc-openapi] Failed to convert query param "${key}" schema, falling back to string:`, e);
          }
        }
        const isArray = unwrapShallow(fieldSchema as z.ZodType) instanceof z.ZodArray;
        const qpDescription = (fieldSchema as ZodTypeAny).description;
        parameters.push({
          name: key,
          in: 'query' as const,
          required: !isOptional,
          schema: jsonSchema,
          ...(isArray ? { style: 'form', explode: true } : {}),
          ...(qpDescription ? { description: qpDescription } : {}),
        });
      }
    }

    // Only add security if securitySchemes are configured and protect !== false
    const hasSecurity = Object.keys(securitySchemes).length > 0 && openapi.protect !== false;
    const security = hasSecurity
      ? [Object.fromEntries(Object.keys(securitySchemes).map((k) => [k, []]))]
      : undefined;

    const operation: Record<string, unknown> = {
      operationId,
      summary: openapi.summary,
      description: openapi.description,
      tags: openapi.tags,
      deprecated: openapi.deprecated,
      parameters: parameters.length > 0 ? parameters : undefined,
      security
    };

    // Request body for POST/PUT/PATCH — pass Zod schema directly for createDocument
    // Skip requestBody when all input fields are path params (empty body)
    if (['POST', 'PUT', 'PATCH'].includes(openapi.method) && inputParser) {
      const bodySchema = excludePathParamsFromSchema(inputParser, pathParams);
      const hasBodyFields = isZodObject(bodySchema) && Object.keys((bodySchema as ZodObject<ZodRawShape>).shape).length > 0;
      if (!isZodObject(bodySchema) || hasBodyFields) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: bodySchema } }
        };
      }
    }

    // Responses — pass Zod schema directly
    const responses: Record<string, unknown> = {};
    if (outputParser) {
      responses['200'] = {
        description: openapi.successDescription ?? 'Successful response',
        content: { 'application/json': { schema: outputParser } }
      };
    } else {
      responses['200'] = {
        description: openapi.successDescription ?? 'Successful response'
      };
    }

    if (openapi.errorResponses) {
      for (const [status, description] of Object.entries(openapi.errorResponses)) {
        responses[String(status)] = {
          description,
          content: { 'application/json': { schema: { type: 'object' as const } } }
        };
      }
    }

    operation.responses = responses;
    zodPaths[pathKey]![method] = operation;
    procedureMeta.push({ pathKey, method, meta, trpcPath, operationId });
  }

  // Use createDocument to convert all Zod schemas to JSON Schema in one pass.
  // This handles transforms, $ref deduplication, and .openapi() annotations.
  const document = createDocument({
    openapi: '3.1.0',
    info: { title: opts.title, description: opts.description, version: opts.version },
    servers: [{ url: opts.baseUrl }],
    paths: zodPaths,
    ...(Object.keys(securitySchemes).length > 0 ?
    { components: { securitySchemes } as Parameters<typeof createDocument>[0]['components'] } :
    {}),
    tags: opts.tags?.map((name) => ({ name })),
    externalDocs: opts.docsUrl ? { url: opts.docsUrl } : undefined
  }) as unknown as OpenApiDocument;

  // Apply extensions (x-access, x-speakeasy-*, etc.) after createDocument
  if (opts.extensions) {
    for (const { pathKey, method, meta, trpcPath, operationId } of procedureMeta) {
      const ext = opts.extensions({ meta, procedurePath: trpcPath, operationId });
      if (ext && document.paths[pathKey]?.[method]) {
        const op = document.paths[pathKey]![method] as Record<string, unknown>;
        for (const [key, value] of Object.entries(ext)) {
          if (value !== undefined) op[key] = value;
        }
      }
    }
  }

  // Wire error response $refs and auto-add 401
  if (opts.errorSchemas && document.paths) {
    const { schemas: statusToSchema, autoAdd401 } = opts.errorSchemas;

    for (const pathItem of Object.values(document.paths)) {
      for (const operation of Object.values(pathItem)) {
        const op = operation as Record<string, unknown>;
        const responses = op.responses as Record<string, Record<string, unknown>> | undefined;
        if (!responses) continue;

        // Replace inline error schemas with $refs
        for (const [statusCode, response] of Object.entries(responses)) {
          const status = parseInt(statusCode, 10);
          const schemaName = statusToSchema[status];
          const content = response.content as Record<string, Record<string, unknown>> | undefined;
          if (schemaName && content?.['application/json']?.schema) {
            content['application/json'].schema = { $ref: `#/components/schemas/${schemaName}` };
          }
        }

        // Auto-add 401 if configured
        if (autoAdd401 && !responses['401'] && statusToSchema[401]) {
          responses['401'] = {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${statusToSchema[401]}` }
              }
            }
          };
        }
      }
    }
  }

  // Add registered error schemas to components.schemas (only those actually $ref'd)
  if (_errorSchemaRegistry.length > 0 && document.paths) {
    const referencedRefs = new Set(
      [...JSON.stringify(document.paths).matchAll(/#\/components\/schemas\/(Error\w+)/g)].map(m => m[1])
    );
    for (const { refName, description, code, message } of _errorSchemaRegistry) {
      if (!referencedRefs.has(refName)) continue;
      if (!document.components) document.components = {};
      if (!document.components.schemas) document.components.schemas = {};
      document.components.schemas[refName] = createSchema(z.object({
        message: z.string().meta({ description: 'The error message', example: message }),
        code: z.string().meta({ description: 'The error code', example: code }),
        issues: z.array(z.object({ message: z.string() })).optional().meta({
          description: 'An array of issues that were responsible for the error', example: []
        })
      }).meta({ description })).schema;
    }
  }

  return document;
}

// ─── Error schema helper ──────────────────────────────────────────────

const _errorSchemaRegistry: Array<{ refName: string; description: string; code: string; message: string }> = [];

/**
 * Create a standard tRPC error response Zod schema with OpenAPI ref.
 * Use this to define error component schemas that the generator auto-wires.
 */
export function createErrorResponseSchema(refName: string, code: string, message: string) {
  _errorSchemaRegistry.push({ refName, description: `${message} error`, code, message });
  return z.object({
    message: z.string().meta({ description: 'The error message', example: message }),
    code: z.string().meta({ description: 'The error code', example: code }),
    issues: z.array(
      z.object({ message: z.string() })
    ).optional().meta({
      description: 'An array of issues that were responsible for the error',
      example: []
    })
  }).meta({ id: refName, description: `${message} error` });
}