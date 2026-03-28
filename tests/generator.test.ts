import { describe, it, expect } from 'vitest';
import { generateOpenApiDocument } from '../src/generator';
import { testRouter } from './fixtures/router';

const doc = generateOpenApiDocument(testRouter, {
  title: 'Test API',
  version: '1.0.0',
  baseUrl: 'http://localhost:3000/api',
  securitySchemes: {
    api_key: {
      type: 'http',
      scheme: 'bearer',
    },
  },
});

describe('generator', () => {
  it('generates valid OpenAPI 3.1.0 document', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Test API');
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.servers).toEqual([{ url: 'http://localhost:3000/api' }]);
  });

  it('includes endpoints with openapi meta', () => {
    expect(doc.paths['/v2/runs']).toBeDefined();
    expect(doc.paths['/v2/runs/{id}']).toBeDefined();
    expect(doc.paths['/v2/health']).toBeDefined();
  });

  it('excludes endpoints without openapi meta', () => {
    const allPaths = Object.keys(doc.paths);
    expect(allPaths).not.toContain('/internal');
  });

  it('excludes disabled endpoints', () => {
    const allPaths = Object.keys(doc.paths);
    expect(allPaths).not.toContain('/v2/disabled');
  });

  it('generates correct methods', () => {
    expect(doc.paths['/v2/runs']?.['post']).toBeDefined();
    expect(doc.paths['/v2/runs']?.['get']).toBeDefined();
    expect(doc.paths['/v2/runs/{id}']?.['get']).toBeDefined();
    expect(doc.paths['/v2/runs/{id}']?.['delete']).toBeDefined();
    expect(doc.paths['/v2/runs/{id}']?.['put']).toBeDefined();
    expect(doc.paths['/v2/health']?.['get']).toBeDefined();
  });

  it('includes path parameters', () => {
    const getOp = doc.paths['/v2/runs/{id}']?.['get'] as Record<string, unknown>;
    const params = getOp.parameters as Array<{ name: string; in: string; required: boolean }>;
    expect(params).toContainEqual({
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  });

  it('includes query parameters for GET endpoints', () => {
    const listOp = doc.paths['/v2/runs']?.['get'] as Record<string, unknown>;
    const params = listOp.parameters as Array<{ name: string; in: string }>;
    const paramNames = params?.map((p) => p.name) ?? [];
    expect(paramNames).toContain('limit');
    expect(paramNames).toContain('offset');
  });

  it('marks optional query params as not required', () => {
    const listOp = doc.paths['/v2/runs']?.['get'] as Record<string, unknown>;
    const params = listOp.parameters as Array<{ name: string; required: boolean }>;
    const limitParam = params.find((p) => p.name === 'limit');
    expect(limitParam?.required).toBe(false);
  });

  it('includes request body for POST endpoints', () => {
    const createOp = doc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
    expect(createOp.requestBody).toBeDefined();
    const reqBody = createOp.requestBody as Record<string, unknown>;
    expect(reqBody.content).toHaveProperty('application/json');
  });

  it('excludes path params from request body in PUT', () => {
    const updateOp = doc.paths['/v2/runs/{id}']?.['put'] as Record<string, unknown>;
    const reqBody = updateOp.requestBody as { content: { 'application/json': { schema: Record<string, unknown> } } };
    const schema = reqBody.content['application/json'].schema;
    // Should have 'status' but not 'id' (id is a path param)
    expect(schema.properties).toHaveProperty('status');
    expect(schema.properties).not.toHaveProperty('id');
  });

  it('includes summary and tags', () => {
    const createOp = doc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
    expect(createOp.summary).toBe('Create run');
    expect(createOp.tags).toEqual(['Runs']);
  });

  it('includes security schemes', () => {
    expect(doc.components?.securitySchemes).toEqual({
      api_key: { type: 'http', scheme: 'bearer' },
    });
  });

  it('respects filter option', () => {
    const filtered = generateOpenApiDocument(testRouter, {
      title: 'Test',
      version: '1.0.0',
      baseUrl: 'http://localhost/api',
      filter: ({ metadata }) => metadata.openapi?.tags?.includes('Runs') ?? false,
    });
    expect(filtered.paths['/v2/health']).toBeUndefined();
    expect(filtered.paths['/v2/runs']).toBeDefined();
  });

  it('includes docsUrl as externalDocs', () => {
    const docWithDocs = generateOpenApiDocument(testRouter, {
      title: 'Test',
      version: '1.0.0',
      baseUrl: 'http://localhost/api',
      docsUrl: 'https://docs.example.com',
    });
    expect(docWithDocs.externalDocs).toEqual({ url: 'https://docs.example.com' });
  });

  it('uses dash-separated operationId', () => {
    const createOp = doc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
    expect(createOp.operationId).toBe('runs-create');
  });

  describe('extensions callback', () => {
    const extDoc = generateOpenApiDocument(testRouter, {
      title: 'Test',
      version: '1.0.0',
      baseUrl: 'http://localhost/api',
      extensions: ({ meta, procedurePath, operationId }) => {
        const ext: Record<string, unknown> = {};

        // Forward xAccess as x-access
        const xAccess = (meta as Record<string, unknown>).xAccess;
        if (xAccess) ext['x-access'] = xAccess;

        // Forward x-speakeasy-group from openapi meta
        if (meta.openapi?.['x-speakeasy-group']) {
          ext['x-speakeasy-group'] = meta.openapi['x-speakeasy-group'];
        }

        // Auto-compute x-speakeasy-name-override from last path segment
        ext['x-speakeasy-name-override'] = procedurePath[procedurePath.length - 1];

        return ext;
      },
    });

    it('adds x-access from meta.xAccess', () => {
      const createOp = extDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      const xAccess = createOp['x-access'] as Array<{ level: string; authType: string }>;
      expect(xAccess).toBeDefined();
      expect(xAccess).toHaveLength(2);
      expect(xAccess[0]!.level).toBe('limited');
      expect(xAccess[0]!.authType).toBe('station');
      expect(xAccess[1]!.level).toBe('full');
      expect(xAccess[1]!.authType).toBe('user');
    });

    it('adds x-speakeasy-group from openapi meta', () => {
      const createOp = extDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      expect(createOp['x-speakeasy-group']).toBe('runs');
    });

    it('adds x-speakeasy-name-override computed from procedure path', () => {
      const createOp = extDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      expect(createOp['x-speakeasy-name-override']).toBe('create');

      const getOp = extDoc.paths['/v2/runs/{id}']?.['get'] as Record<string, unknown>;
      expect(getOp['x-speakeasy-name-override']).toBe('get');

      const listOp = extDoc.paths['/v2/runs']?.['get'] as Record<string, unknown>;
      expect(listOp['x-speakeasy-name-override']).toBe('list');
    });

    it('does not add extensions to endpoints without xAccess', () => {
      const healthOp = extDoc.paths['/v2/health']?.['get'] as Record<string, unknown>;
      expect(healthOp['x-access']).toBeUndefined();
      expect(healthOp['x-speakeasy-group']).toBeUndefined();
      // name-override is always set by our callback
      expect(healthOp['x-speakeasy-name-override']).toBeDefined();
    });

    it('does not add extensions when callback returns undefined', () => {
      const noExtDoc = generateOpenApiDocument(testRouter, {
        title: 'Test',
        version: '1.0.0',
        baseUrl: 'http://localhost/api',
        extensions: () => undefined,
      });
      const createOp = noExtDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      expect(createOp['x-access']).toBeUndefined();
      expect(createOp['x-speakeasy-group']).toBeUndefined();
    });
  });

  describe('deeply nested routers', () => {
    it('generates paths for deeply nested procedures', () => {
      expect(doc.paths['/v2/org/{orgId}/team/{teamId}/member/{memberId}']).toBeDefined();
      const op = doc.paths['/v2/org/{orgId}/team/{teamId}/member/{memberId}']?.['get'] as Record<string, unknown>;
      expect(op).toBeDefined();
      expect(op.operationId).toBe('org-team-member-get');
    });

    it('generates all path parameters for deeply nested routes', () => {
      const op = doc.paths['/v2/org/{orgId}/team/{teamId}/member/{memberId}']?.['get'] as Record<string, unknown>;
      const params = op.parameters as Array<{ name: string; in: string }>;
      const paramNames = params.map((p) => p.name);
      expect(paramNames).toContain('orgId');
      expect(paramNames).toContain('teamId');
      expect(paramNames).toContain('memberId');
    });
  });

  describe('security configuration', () => {
    it('adds security to operations when securitySchemes provided', () => {
      const createOp = doc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      expect(createOp.security).toBeDefined();
      expect(createOp.security).toEqual([{ api_key: [] }]);
    });

    it('omits security when no securitySchemes configured', () => {
      const noSecDoc = generateOpenApiDocument(testRouter, {
        title: 'Test',
        version: '1.0.0',
        baseUrl: 'http://localhost/api',
      });
      const createOp = noSecDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      expect(createOp.security).toBeUndefined();
    });

    it('omits security when protect is false', () => {
      const op = doc.paths['/v2/public-info']?.['get'] as Record<string, unknown>;
      expect(op.security).toBeUndefined();
    });
  });

  describe('default and optional query params', () => {
    it('marks default params as not required', () => {
      const op = doc.paths['/v2/defaults']?.['get'] as Record<string, unknown>;
      const params = op.parameters as Array<{ name: string; required: boolean }>;
      const pageParam = params.find((p) => p.name === 'page');
      const sizeParam = params.find((p) => p.name === 'size');
      expect(pageParam?.required).toBe(false);
      expect(sizeParam?.required).toBe(false);
    });
  });

  describe('error schemas config', () => {
    const errorDoc = generateOpenApiDocument(testRouter, {
      title: 'Test',
      version: '1.0.0',
      baseUrl: 'http://localhost/api',
      securitySchemes: { api_key: { type: 'http', scheme: 'bearer' } },
      errorSchemas: {
        schemas: { 400: 'ErrorBadRequest', 401: 'ErrorUnauthorized' },
        autoAdd401: true,
      },
    });

    it('auto-adds 401 to operations', () => {
      const createOp = errorDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      const responses = createOp.responses as Record<string, Record<string, unknown>>;
      expect(responses['401']).toBeDefined();
      expect(responses['401']!.description).toBe('Unauthorized');
    });

    it('uses $ref for error response schemas', () => {
      const createOp = errorDoc.paths['/v2/runs']?.['post'] as Record<string, unknown>;
      const responses = createOp.responses as Record<string, Record<string, unknown>>;
      if (responses['401']?.content) {
        const content = responses['401']!.content as Record<string, Record<string, unknown>>;
        expect(content['application/json']!.schema).toEqual({
          $ref: '#/components/schemas/ErrorUnauthorized',
        });
      }
    });
  });

  describe('transformed input', () => {
    it('includes transformed endpoint in paths', () => {
      expect(doc.paths['/v2/transformed']).toBeDefined();
      const op = doc.paths['/v2/transformed']?.['post'] as Record<string, unknown>;
      expect(op).toBeDefined();
      expect(op.requestBody).toBeDefined();
    });
  });

  describe('array query params in spec', () => {
    it('includes array params in query parameters', () => {
      const op = doc.paths['/v2/search']?.['get'] as Record<string, unknown>;
      const params = op.parameters as Array<{ name: string; in: string }>;
      const paramNames = params?.map((p) => p.name) ?? [];
      expect(paramNames).toContain('tags');
      expect(paramNames).toContain('ids');
    });

    it('sets style and explode on array query params', () => {
      const op = doc.paths['/v2/search']?.['get'] as Record<string, unknown>;
      const params = op.parameters as Array<{ name: string; style?: string; explode?: boolean }>;
      const tagsParam = params.find((p) => p.name === 'tags');
      expect(tagsParam?.style).toBe('form');
      expect(tagsParam?.explode).toBe(true);
    });

    it('does not set style/explode on non-array query params', () => {
      const op = doc.paths['/v2/runs']?.['get'] as Record<string, unknown>;
      const params = op.parameters as Array<{ name: string; style?: string }>;
      const limitParam = params.find((p) => p.name === 'limit');
      expect(limitParam?.style).toBeUndefined();
    });
  });
});
