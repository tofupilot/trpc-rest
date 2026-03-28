import { describe, it, expect } from 'vitest';
import { createOpenApiFetchHandler } from '../src/handler';
import { testRouter } from './fixtures/router';
import type { FetchHandlerOptions } from '../src/types';

interface JsonBody {
  id?: string;
  status?: string;
  ok?: boolean;
  success?: boolean;
  code?: string;
  message?: string;
  issues?: unknown[];
  [key: string]: unknown;
}

function makeOpts(req: Request, overrides?: Partial<FetchHandlerOptions>): FetchHandlerOptions {
  return {
    router: testRouter,
    endpoint: '/api',
    req,
    createContext: async () => ({ userId: 'test-user' }),
    ...overrides,
  };
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(url, init);
}

describe('handler', () => {
  describe('routing', () => {
    it('returns 404 for unknown path', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/unknown')));
      expect(res.status).toBe(404);
    });

    it('returns 404 for wrong method', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('PATCH', '/api/v2/runs')));
      expect(res.status).toBe(404);
    });

    it('returns 200 for HEAD on existing path', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('HEAD', '/api/v2/health')));
      expect(res.status).toBe(200);
    });

    it('returns 404 for HEAD on non-existent path', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('HEAD', '/api/v2/unknown')));
      expect(res.status).toBe(404);
    });

    it('does not expose disabled endpoints', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/disabled')));
      expect(res.status).toBe(404);
    });
  });

  describe('GET with path params', () => {
    it('handles GET /v2/runs/{id}', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/runs/abc-123')));
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ id: 'abc-123', status: 'PASS' });
    });
  });

  describe('GET with query params and coercion', () => {
    it('handles GET /v2/runs with numeric query params', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/runs?limit=3')));
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toHaveLength(3);
    });
  });

  describe('POST with JSON body', () => {
    it('handles POST /v2/runs', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('POST', '/api/v2/runs', { procedureId: 'proc-1' }))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.id).toBe('run-1');
      expect(body.status).toBe('PASS');
    });

    it('rejects POST without content-type when body is needed', async () => {
      const req = new Request('http://localhost/api/v2/runs', {
        method: 'POST',
        body: '{}',
      });
      const res = await createOpenApiFetchHandler(makeOpts(req));
      expect(res.status).toBe(415);
    });
  });

  describe('PUT with path param + body (mixed input)', () => {
    it('handles PUT /v2/runs/{id} with body', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('PUT', '/api/v2/runs/run-42', { status: 'FAIL' }))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ id: 'run-42', status: 'FAIL' });
    });
  });

  describe('DELETE with path params only', () => {
    it('handles DELETE /v2/runs/{id} without body', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('DELETE', '/api/v2/runs/abc-123')));
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ success: true });
    });
  });

  describe('void input (no schema)', () => {
    it('handles GET /v2/health with no input', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/health')));
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ ok: true });
    });
  });

  describe('error handling', () => {
    it('returns TRPCError with correct status code', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/fail')));
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.code).toBe('BAD_REQUEST');
      expect(body.message).toBe('This always fails');
    });

    it('calls onError callback', async () => {
      let capturedError: unknown = null;
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/fail'), {
          onError: ({ error }) => {
            capturedError = error;
          },
        })
      );
      expect(res.status).toBe(400);
      expect(capturedError).not.toBeNull();
    });

    it('returns input validation error for bad input', async () => {
      // POST without required field
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('POST', '/api/v2/runs', {}))
      );
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.message).toBe('Input validation failed');
      expect(body.issues).toBeDefined();
    });
  });

  describe('middleware execution', () => {
    it('runs auth middleware via createCaller', async () => {
      // Health endpoint uses t.procedure (no auth) — should work even with empty userId
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/health'), {
          createContext: async () => ({ userId: '' }),
        })
      );
      expect(res.status).toBe(200);
    });
  });

  describe('deeply nested routers', () => {
    it('handles deeply nested route with multiple path params', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/org/org-1/team/team-2/member/user-3'))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ orgId: 'org-1', teamId: 'team-2', memberId: 'user-3' });
    });
  });

  describe('transformed input', () => {
    it('handles POST with transformed input schema', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('POST', '/api/v2/transformed', { value: 'hello' }))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ value: 'hello', extra: true });
    });
  });

  describe('default values', () => {
    it('handles GET with default query param values', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/defaults'))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ page: 1, size: 20 });
    });

    it('overrides defaults with provided query params', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/defaults?page=5&size=50'))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ page: 5, size: 50 });
    });
  });

  describe('array query params', () => {
    it('wraps single value into array', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/search?tags=alpha'))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.tags).toEqual(['alpha']);
    });

    it('handles repeated query params as array', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/search?tags=a&tags=b&tags=c'))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.tags).toEqual(['a', 'b', 'c']);
    });

    it('coerces numeric array elements from query string', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/search?ids=1&ids=2&ids=3'))
      );
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ids).toEqual([1, 2, 3]);
    });
  });

  describe('form-urlencoded body', () => {
    it('handles application/x-www-form-urlencoded POST', async () => {
      const req = new Request('http://localhost/api/v2/form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=Jane&email=jane@example.com',
      });
      const res = await createOpenApiFetchHandler(makeOpts(req));
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ ok: true });
    });
  });

  describe('non-TRPCError handling', () => {
    it('wraps non-TRPCError as INTERNAL_SERVER_ERROR', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/crash'))
      );
      expect(res.status).toBe(500);
      const body = await res.json() as JsonBody;
      expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('responseMeta callback', () => {
    it('applies custom status code from responseMeta', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/health'), {
          responseMeta: () => ({ status: 201, headers: { 'X-Custom': 'test' } }),
        })
      );
      expect(res.status).toBe(201);
      expect(res.headers.get('X-Custom')).toBe('test');
    });

    it('applies responseMeta on error too', async () => {
      const res = await createOpenApiFetchHandler(
        makeOpts(makeRequest('GET', '/api/v2/fail'), {
          responseMeta: ({ errors }) => {
            if (errors.length > 0) return { headers: { 'X-Error': 'true' } };
            return undefined;
          },
        })
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('X-Error')).toBe('true');
    });
  });

  describe('content-type edge cases', () => {
    it('rejects unsupported content-type on POST with body', async () => {
      const req = new Request('http://localhost/api/v2/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: '<data/>',
      });
      const res = await createOpenApiFetchHandler(makeOpts(req));
      expect(res.status).toBe(415);
      const body = await res.json() as JsonBody;
      expect(body.message).toContain('text/xml');
    });

    it('accepts POST with path-only params without content-type', async () => {
      // DELETE /v2/runs/{id} only has path params, no body needed
      const req = new Request('http://localhost/api/v2/runs/test-id', {
        method: 'DELETE',
      });
      const res = await createOpenApiFetchHandler(makeOpts(req));
      expect(res.status).toBe(200);
    });
  });

  describe('route caching', () => {
    it('returns consistent results across multiple requests (cache hit)', async () => {
      const res1 = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/health')));
      const res2 = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/health')));
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      const body1 = await res1.json();
      const body2 = await res2.json();
      expect(body1).toEqual(body2);
    });
  });

  describe('schema mutation safety', () => {
    it('does not mutate shared schema after coercion', async () => {
      // First request coerces query params
      await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/runs?limit=5')));
      // Second request should still work correctly (schema not mutated)
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/runs?limit=3')));
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toHaveLength(3);
    });
  });

  describe('JSON parse error', () => {
    it('returns PARSE_ERROR for malformed JSON body', async () => {
      const req = new Request('http://localhost/api/v2/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });
      const res = await createOpenApiFetchHandler(makeOpts(req));
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.code).toBe('PARSE_ERROR');
    });
  });

  describe('error response safety', () => {
    it('does not leak stack traces in error response', async () => {
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/crash')));
      expect(res.status).toBe(500);
      const body = await res.json() as JsonBody;
      expect(body.code).toBe('INTERNAL_SERVER_ERROR');
      // The 'data' field from errorShape (which contains stack, httpStatus, path) should be stripped
      expect(body.data).toBeUndefined();
    });

    it('wraps non-TRPCError as INTERNAL_SERVER_ERROR (not as the raw error code)', async () => {
      // A Node SystemError with code: 'ENOENT' should NOT be treated as a TRPCError
      const res = await createOpenApiFetchHandler(makeOpts(makeRequest('GET', '/api/v2/crash')));
      const body = await res.json() as JsonBody;
      // Should be INTERNAL_SERVER_ERROR, not some random code from the original Error
      expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
