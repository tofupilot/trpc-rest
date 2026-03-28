import { z } from 'zod';

// ─── Path utilities ──────────────────────────────────────────────────

/**
 * Convert an OpenAPI path pattern to a regex with named capture groups.
 * e.g. "/v2/runs/{id}" → /^\/v2\/runs\/(?<id>[^/]+)$/i
 */
export function pathToRegex(path: string): { regex: RegExp; params: string[] } {
  const params: string[] = [];
  const regexStr = path.replace(/\{([^}]+)\}/g, (_, param: string) => {
    params.push(param);
    return `(?<${param}>[^/]+)`;
  });
  return { regex: new RegExp(`^${regexStr}$`, 'i'), params };
}

/**
 * Extract path parameters from a URL using named capture groups.
 */
export function extractPathParams(
  pathname: string,
  regex: RegExp
): Record<string, string> | null {
  const match = pathname.match(regex);
  if (!match) return null;

  const params: Record<string, string> = {};
  if (match.groups) {
    for (const [key, value] of Object.entries(match.groups)) {
      if (value !== undefined) {
        params[key] = decodeURIComponent(value);
      }
    }
  }
  return params;
}

/**
 * Parse query string from a URL. Single values stay strings,
 * repeated keys become arrays.
 */
export function extractQueryParams(url: URL): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  const counts: Record<string, number> = {};

  url.searchParams.forEach((value, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
    if (counts[key]! > 1) {
      const existing = params[key];
      if (!Array.isArray(existing)) {
        params[key] = [existing as string, value];
      } else {
        existing.push(value);
      }
    } else {
      params[key] = value;
    }
  });

  return params;
}

/**
 * Normalize a path: ensure leading slash, strip trailing slash.
 */
export function normalizePath(path: string): string {
  return `/${path.replace(/^\/|\/$/g, '')}`;
}

// ─── Input merging ──────────────────────────────────────────────────

/**
 * Merge multiple tRPC input schemas into a single schema.
 * Only ZodObject inputs can be merged; non-object inputs are returned as-is (last wins).
 */
export function mergeInputs(inputs: z.ZodType[]): z.ZodType | undefined {
  if (inputs.length === 0) return undefined;
  if (inputs.length === 1) return inputs[0];

  // Only merge if all inputs unwrap to ZodObject (don't unwrap arrays — z.array(z.object) is not mergeable)
  const allObjects = inputs.every((input) => isZodObject(unwrapShallow(input)));
  if (!allObjects) return inputs.at(-1);

  return inputs.reduce<z.ZodType>(
    (acc, input) => {
      const unwrappedInput = unwrapShallow(input);
      if (isZodObject(acc) && isZodObject(unwrappedInput)) {
        return acc.merge(unwrappedInput as z.ZodObject<z.ZodRawShape>);
      }
      return acc;
    },
    z.object({})
  );
}

// ─── Zod schema introspection ────────────────────────────────────────

export function isZodObject(schema: z.ZodType): schema is z.ZodObject<Record<string, z.ZodType>> {
  return schema instanceof z.ZodObject;
}

/**
 * Unwrap Zod wrapper types to get the underlying schema.
 * Uses Zod 4 public API: instanceof + .unwrap() / .in / .element.
 */
export function unwrapZodType(schema: z.ZodType, unwrapPreprocess: boolean): z.ZodType {
  if (schema instanceof z.ZodArray) {
    return unwrapZodType(schema.element as z.ZodType, unwrapPreprocess);
  }
  if (schema instanceof z.ZodEnum) {
    return schema;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapZodType(schema.unwrap() as z.ZodType, unwrapPreprocess);
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapZodType(schema.removeDefault() as z.ZodType, unwrapPreprocess);
  }
  if (schema instanceof z.ZodLazy) {
    return unwrapZodType(schema.unwrap() as z.ZodType, unwrapPreprocess);
  }
  if (schema instanceof z.ZodPipe) {
    return unwrapZodType(schema.in as z.ZodType, unwrapPreprocess);
  }
  if (schema instanceof z.ZodTransform) {
    const inner = (schema as unknown as { _zod: { def: z.ZodType } })._zod.def;
    if (inner) return unwrapZodType(inner, unwrapPreprocess);
  }

  return schema;
}

/**
 * Check if a Zod schema is void-like (z.void(), z.undefined(), z.never()).
 */
export function isVoidLike(schema: z.ZodType | undefined): boolean {
  if (!schema) return true;
  return (
    schema instanceof z.ZodVoid ||
    schema instanceof z.ZodUndefined ||
    schema instanceof z.ZodNever
  );
}

/**
 * Determine if a request needs a body, or if all input comes from path params.
 */
export function hasBodyFields(
  schema: z.ZodType | undefined,
  pathParams: Record<string, string> | null
): boolean {
  if (!schema || isVoidLike(schema)) return false;

  const unwrapped = unwrapZodType(schema, true);
  if (!isZodObject(unwrapped)) return true;

  const shapeKeys = Object.keys(unwrapped.shape);
  if (!pathParams) return shapeKeys.length > 0;
  return shapeKeys.some((key) => !(key in pathParams));
}

/**
 * Coerce string query param values to their expected types based on the Zod schema.
 * Returns a new object with coerced values — does NOT mutate the original schema.
 */
export function coerceQueryParams(
  schema: z.ZodType,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (!isZodObject(schema)) return input;

  const result = { ...input };
  for (const [key, shapeSchema] of Object.entries(schema.shape)) {
    if (!(key in result)) continue;
    const value = result[key];

    // Unwrap optional/nullable/default but NOT arrays (we need to detect arrays before unwrapping)
    const unwrappedShallow = unwrapShallow(shapeSchema as z.ZodType);

    if (unwrappedShallow instanceof z.ZodArray && Array.isArray(value)) {
      const elementType = unwrapZodType(unwrappedShallow.element as z.ZodType, false);
      result[key] = value.map((item) => coerceValue(elementType, item));
    } else {
      const unwrapped = unwrapZodType(shapeSchema as z.ZodType, false);
      if (unwrapped instanceof z.ZodNumber && typeof value === 'string') {
        const num = Number(value);
        if (!Number.isNaN(num)) result[key] = num;
      } else if (unwrapped instanceof z.ZodBoolean && typeof value === 'string') {
        if (value === 'true' || value === '1') result[key] = true;
        else if (value === 'false' || value === '0') result[key] = false;
      } else if (unwrapped instanceof z.ZodBigInt && typeof value === 'string') {
        try { result[key] = BigInt(value); } catch { /* leave as string, let validation catch it */ }
      } else if (unwrapped instanceof z.ZodDate && typeof value === 'string') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) result[key] = date;
      } else if (isZodObject(unwrapped) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = coerceQueryParams(unwrapped, value as Record<string, unknown>);
      }
    }
  }
  return result;
}

/** Unwrap optional/nullable/default wrappers but stop at arrays and other concrete types. */
export function unwrapShallow(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapShallow(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapShallow(schema.removeDefault() as z.ZodType);
  }
  return schema;
}

/** Coerce a single value based on its expected Zod type. */
function coerceValue(schema: z.ZodType, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (schema instanceof z.ZodNumber) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  if (schema instanceof z.ZodBoolean) {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }
  if (schema instanceof z.ZodBigInt) {
    try { return BigInt(value); } catch { return value; }
  }
  if (schema instanceof z.ZodDate) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}
