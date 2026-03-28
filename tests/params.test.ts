import { describe, it, expect } from 'vitest';
import { z } from "zod";
import {
  pathToRegex,
  extractPathParams,
  extractQueryParams,
  normalizePath,
  hasBodyFields,
  isVoidLike,
  unwrapZodType,
  coerceQueryParams,
  mergeInputs } from
'../src/params';

describe('pathToRegex', () => {
  it('converts simple path', () => {
    const { regex, params } = pathToRegex('/v2/runs');
    expect(params).toEqual([]);
    expect(regex.test('/v2/runs')).toBe(true);
    expect(regex.test('/v2/runs/extra')).toBe(false);
  });

  it('extracts single param', () => {
    const { regex, params } = pathToRegex('/v2/runs/{id}');
    expect(params).toEqual(['id']);
    expect(regex.test('/v2/runs/abc-123')).toBe(true);
    expect(regex.test('/v2/runs/')).toBe(false);
  });

  it('extracts multiple params', () => {
    const { regex, params } = pathToRegex('/v2/runs/{runId}/logs/{logId}');
    expect(params).toEqual(['runId', 'logId']);
    expect(regex.test('/v2/runs/r1/logs/l1')).toBe(true);
  });

  it('is case insensitive', () => {
    const { regex } = pathToRegex('/v2/runs');
    expect(regex.test('/V2/Runs')).toBe(true);
  });
});

describe('extractPathParams', () => {
  it('extracts params from matching path', () => {
    const { regex } = pathToRegex('/v2/runs/{id}');
    const result = extractPathParams('/v2/runs/abc-123', regex);
    expect(result).toEqual({ id: 'abc-123' });
  });

  it('extracts multiple params', () => {
    const { regex } = pathToRegex('/v2/runs/{runId}/logs/{logId}');
    const result = extractPathParams('/v2/runs/r1/logs/l1', regex);
    expect(result).toEqual({ runId: 'r1', logId: 'l1' });
  });

  it('decodes URI components', () => {
    const { regex } = pathToRegex('/v2/runs/{id}');
    const result = extractPathParams('/v2/runs/hello%20world', regex);
    expect(result).toEqual({ id: 'hello world' });
  });

  it('returns null for non-matching path', () => {
    const { regex } = pathToRegex('/v2/runs/{id}');
    const result = extractPathParams('/v2/units/abc', regex);
    expect(result).toBeNull();
  });
});

describe('extractQueryParams', () => {
  it('extracts single-value query params', () => {
    const url = new URL('http://localhost/v2/runs?limit=10&offset=20');
    expect(extractQueryParams(url)).toEqual({ limit: '10', offset: '20' });
  });

  it('returns empty for no params', () => {
    const url = new URL('http://localhost/v2/runs');
    expect(extractQueryParams(url)).toEqual({});
  });

  it('handles multi-value params', () => {
    const url = new URL('http://localhost/v2/runs?tag=a&tag=b');
    expect(extractQueryParams(url)).toEqual({ tag: ['a', 'b'] });
  });
});

describe('normalizePath', () => {
  it('adds leading slash', () => {
    expect(normalizePath('v2/runs')).toBe('/v2/runs');
  });
  it('strips trailing slash', () => {
    expect(normalizePath('/v2/runs/')).toBe('/v2/runs');
  });
  it('handles already normalized', () => {
    expect(normalizePath('/v2/runs')).toBe('/v2/runs');
  });
  it('handles root path', () => {
    expect(normalizePath('/')).toBe('/');
  });
  it('handles empty string as root', () => {
    expect(normalizePath('')).toBe('/');
  });
});

describe('unwrapZodType', () => {
  it('unwraps optional', () => {
    const wrapped = z.string().optional();
    const result = unwrapZodType(wrapped, false);
    expect(result).toBeInstanceOf(z.ZodString);
  });

  it('unwraps nullable', () => {
    const wrapped = z.number().nullable();
    const result = unwrapZodType(wrapped, false);
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it('unwraps default', () => {
    const wrapped = z.number().default(42);
    const result = unwrapZodType(wrapped, false);
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it('unwraps refinement (stays as original type in Zod 4)', () => {
    const inner = z.string().refine((v) => v.length > 0);
    const result = unwrapZodType(inner, false);
    expect(result).toBeInstanceOf(z.ZodString);
  });

  it('does not change plain types', () => {
    const plain = z.object({ a: z.string() });
    const result = unwrapZodType(plain, false);
    expect(result).toBe(plain);
  });
});

describe('coerceQueryParams', () => {
  it('coerces string to number', () => {
    const schema = z.object({ count: z.number(), name: z.string() });
    const result = coerceQueryParams(schema, { count: '42', name: 'hello' });
    expect(result).toEqual({ count: 42, name: 'hello' });
  });

  it('coerces string to boolean', () => {
    const schema = z.object({ active: z.boolean() });
    expect(coerceQueryParams(schema, { active: 'true' })).toEqual({ active: true });
    expect(coerceQueryParams(schema, { active: 'false' })).toEqual({ active: false });
    expect(coerceQueryParams(schema, { active: '1' })).toEqual({ active: true });
    expect(coerceQueryParams(schema, { active: '0' })).toEqual({ active: false });
  });

  it('coerces string to bigint', () => {
    const schema = z.object({ id: z.bigint() });
    const result = coerceQueryParams(schema, { id: '9007199254740993' });
    expect(result).toEqual({ id: 9007199254740993n });
  });

  it('coerces string to date', () => {
    const schema = z.object({ after: z.date() });
    const result = coerceQueryParams(schema, { after: '2024-01-01T00:00:00Z' });
    expect(result.after).toBeInstanceOf(Date);
  });

  it('coerces array elements', () => {
    const schema = z.object({ ids: z.array(z.number()) });
    const result = coerceQueryParams(schema, { ids: ['1', '2', '3'] });
    expect(result).toEqual({ ids: [1, 2, 3] });
  });

  it('does not mutate the original schema', () => {
    const schema = z.object({ count: z.number() });
    const defBefore = JSON.stringify((schema.shape.count as z.ZodNumber)._def);
    coerceQueryParams(schema, { count: '42' });
    const defAfter = JSON.stringify((schema.shape.count as z.ZodNumber)._def);
    expect(defBefore).toBe(defAfter);
  });

  it('leaves non-matching types as-is', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceQueryParams(schema, { count: 'not-a-number' });
    expect(result).toEqual({ count: 'not-a-number' });
  });

  it('returns input as-is for non-object schema', () => {
    const schema = z.string();
    const input = { foo: 'bar' };
    expect(coerceQueryParams(schema, input)).toBe(input);
  });
});

describe('isVoidLike', () => {
  it('returns true for void', () => expect(isVoidLike(z.void())).toBe(true));
  it('returns true for undefined', () => expect(isVoidLike(z.undefined())).toBe(true));
  it('returns true for never', () => expect(isVoidLike(z.never())).toBe(true));
  it('returns true for undefined arg', () => expect(isVoidLike(undefined)).toBe(true));
  it('returns false for object', () => expect(isVoidLike(z.object({}))).toBe(false));
  it('returns false for string', () => expect(isVoidLike(z.string())).toBe(false));
});

describe('hasBodyFields', () => {
  it('returns false for void schema', () => {
    expect(hasBodyFields(z.void(), null)).toBe(false);
  });

  it('returns false when all fields are path params', () => {
    const schema = z.object({ id: z.string() });
    expect(hasBodyFields(schema, { id: '123' })).toBe(false);
  });

  it('returns true when some fields are not path params', () => {
    const schema = z.object({ id: z.string(), name: z.string() });
    expect(hasBodyFields(schema, { id: '123' })).toBe(true);
  });

  it('returns true for non-object schema', () => {
    expect(hasBodyFields(z.string(), null)).toBe(true);
  });

  it('unwraps optional before checking', () => {
    const schema = z.object({ id: z.string() }).optional();
    expect(hasBodyFields(schema, { id: '123' })).toBe(false);
  });
});

describe('mergeInputs', () => {
  it('returns undefined for empty array', () => {
    expect(mergeInputs([])).toBeUndefined();
  });

  it('returns single input as-is', () => {
    const schema = z.object({ a: z.string() });
    expect(mergeInputs([schema])).toBe(schema);
  });

  it('merges two object schemas', () => {
    const a = z.object({ a: z.string() });
    const b = z.object({ b: z.number() });
    const merged = mergeInputs([a, b]);
    expect(merged).toBeDefined();
    const result = merged!.parse({ a: 'hello', b: 42 });
    expect(result).toEqual({ a: 'hello', b: 42 });
  });

  it('merges three object schemas', () => {
    const a = z.object({ a: z.string() });
    const b = z.object({ b: z.number() });
    const c = z.object({ c: z.boolean() });
    const merged = mergeInputs([a, b, c]);
    expect(merged).toBeDefined();
    const result = merged!.parse({ a: 'hi', b: 1, c: true });
    expect(result).toEqual({ a: 'hi', b: 1, c: true });
  });

  it('falls back to last input if not all are objects', () => {
    const a = z.string();
    const b = z.object({ x: z.number() });
    const merged = mergeInputs([a, b]);
    expect(merged).toBe(b);
  });

  it('falls back to last input for array input (does not unwrap array to inner object)', () => {
    const a = z.object({ name: z.string() });
    const b = z.array(z.object({ id: z.number() }));
    const merged = mergeInputs([a, b]);
    // Should return the array schema as-is, not try to merge inner object
    expect(merged).toBe(b);
  });
});

describe('unwrapZodType (extended)', () => {
  it('unwraps ZodPipe (transform)', () => {
    const schema = z.object({ a: z.string() }).transform((v) => ({ ...v, b: true }));
    const result = unwrapZodType(schema, true);
    expect(result).toBeInstanceOf(z.ZodObject);
  });

  it('unwraps ZodTransform', () => {
    // ZodTransform constructor takes (schema, fn) at runtime but TS types only declare 1 arg
    const Ctor = z.ZodTransform as unknown as new (s: z.ZodString, fn: (v: string) => number) => z.ZodTransform;
    const schema = new Ctor(z.string(), (v: string) => v.length);
    const result = unwrapZodType(schema, true);
    expect(result).toBeInstanceOf(z.ZodString);
  });

  it('unwraps nested optional + default', () => {
    const schema = z.number().default(5).optional();
    const result = unwrapZodType(schema, false);
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it('unwraps ZodLazy', () => {
    const schema = z.lazy(() => z.string());
    const result = unwrapZodType(schema, false);
    expect(result).toBeInstanceOf(z.ZodString);
  });

  it('unwraps array to element type', () => {
    const schema = z.array(z.number());
    const result = unwrapZodType(schema, false);
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it('preserves ZodEnum', () => {
    const schema = z.enum(['a', 'b', 'c']);
    const result = unwrapZodType(schema, false);
    expect(result).toBe(schema);
  });
});

describe('coerceQueryParams (extended)', () => {
  it('coerces optional number field', () => {
    const schema = z.object({ count: z.number().optional() });
    const result = coerceQueryParams(schema, { count: '42' });
    expect(result).toEqual({ count: 42 });
  });

  it('handles nested object coercion', () => {
    const schema = z.object({ filter: z.object({ min: z.number(), max: z.number() }) });
    const result = coerceQueryParams(schema, { filter: { min: '1', max: '100' } });
    expect(result).toEqual({ filter: { min: 1, max: 100 } });
  });

  it('skips missing keys', () => {
    const schema = z.object({ a: z.number(), b: z.number() });
    const result = coerceQueryParams(schema, { a: '1' });
    expect(result).toEqual({ a: 1 });
  });

  it('handles optional array of numbers', () => {
    const schema = z.object({ ids: z.array(z.number()).optional() });
    const result = coerceQueryParams(schema, { ids: ['1', '2'] });
    expect(result).toEqual({ ids: [1, 2] });
  });

  it('handles boolean array elements', () => {
    const schema = z.object({ flags: z.array(z.boolean()) });
    const result = coerceQueryParams(schema, { flags: ['true', 'false', '1'] });
    expect(result).toEqual({ flags: [true, false, true] });
  });
});