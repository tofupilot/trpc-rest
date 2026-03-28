import { initTRPC, TRPCError } from '@trpc/server';
import { z } from "zod";
import type { OpenApiMeta } from '../../src/types';

export interface TestContext {
  userId: string;
}

const t = initTRPC.
meta<OpenApiMeta>().
context<TestContext>().
create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message: error.message,
      code: error.code
    };
  }
});

const authMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  return next({ ctx });
});

const authedProcedure = t.procedure.use(authMiddleware);

export const testRouter = t.router({
  runs: t.router({
    create: authedProcedure.
    meta({
      openapi: {
        method: 'POST', path: '/v2/runs', tags: ['Runs'], summary: 'Create run',
        'x-speakeasy-group': 'runs'
      },
      xAccess: [
      { level: 'limited' as const, authType: 'station' as const, description: 'Stations can only create runs for linked procedures' },
      { level: 'full' as const, authType: 'user' as const, description: 'Users can create runs for any procedure' }]

    }).
    input(z.object({ procedureId: z.string(), unitId: z.string().optional() })).
    output(z.object({ id: z.string(), status: z.string() })).
    mutation(async ({ input }) => ({ id: 'run-1', status: 'PASS', ...input })),

    get: authedProcedure.
    meta({
      openapi: { method: 'GET', path: '/v2/runs/{id}', tags: ['Runs'], summary: 'Get run' }
    }).
    input(z.object({ id: z.string() })).
    output(z.object({ id: z.string(), status: z.string() })).
    query(async ({ input }) => ({ id: input.id, status: 'PASS' })),

    list: authedProcedure.
    meta({
      openapi: { method: 'GET', path: '/v2/runs', tags: ['Runs'], summary: 'List runs' }
    }).
    input(z.object({ limit: z.number().optional(), offset: z.number().optional() })).
    output(z.array(z.object({ id: z.string() }))).
    query(async ({ input }) => {
      const limit = input.limit ?? 10;
      return Array.from({ length: limit }, (_, i) => ({ id: `run-${i}` }));
    }),

    delete: authedProcedure.
    meta({
      openapi: { method: 'DELETE', path: '/v2/runs/{id}', tags: ['Runs'], summary: 'Delete run' }
    }).
    input(z.object({ id: z.string() })).
    output(z.object({ success: z.boolean() })).
    mutation(async () => ({ success: true })),

    // PUT with path param + body — tests mixed input
    update: authedProcedure.
    meta({
      openapi: { method: 'PUT', path: '/v2/runs/{id}', tags: ['Runs'], summary: 'Update run' }
    }).
    input(z.object({ id: z.string(), status: z.string() })).
    output(z.object({ id: z.string(), status: z.string() })).
    mutation(async ({ input }) => ({ id: input.id, status: input.status }))
  }),

  // Endpoint with no input (void)
  health: t.procedure.
  meta({
    openapi: { method: 'GET', path: '/v2/health', summary: 'Health check' }
  }).
  output(z.object({ ok: z.boolean() })).
  query(async () => ({ ok: true })),

  // Endpoint that throws an error
  fail: authedProcedure.
  meta({
    openapi: { method: 'GET', path: '/v2/fail', summary: 'Always fails' }
  }).
  output(z.object({ ok: z.boolean() })).
  query(async () => {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This always fails' });
  }),

  // No openapi meta — should be ignored
  internal: t.procedure.
  input(z.object({ secret: z.string() })).
  query(async () => ({ hidden: true })),

  // Disabled endpoint — should be ignored
  disabled: t.procedure.
  meta({
    openapi: { method: 'GET', path: '/v2/disabled', enabled: false }
  }).
  query(async () => ({ nope: true })),

  // Deeply nested router
  org: t.router({
    team: t.router({
      member: t.router({
        get: authedProcedure.
        meta({
          openapi: { method: 'GET', path: '/v2/org/{orgId}/team/{teamId}/member/{memberId}', tags: ['Org'] }
        }).
        input(z.object({ orgId: z.string(), teamId: z.string(), memberId: z.string() })).
        output(z.object({ orgId: z.string(), teamId: z.string(), memberId: z.string() })).
        query(async ({ input }) => input)
      })
    })
  }),

  // Endpoint with transform input
  transformed: authedProcedure.
  meta({
    openapi: { method: 'POST', path: '/v2/transformed', tags: ['Misc'] }
  }).
  input(z.object({ value: z.string() }).transform((v) => ({ ...v, extra: true }))).
  output(z.object({ value: z.string(), extra: z.boolean() })).
  mutation(async ({ input }) => input),

  // Endpoint with default values
  withDefaults: authedProcedure.
  meta({
    openapi: { method: 'GET', path: '/v2/defaults', tags: ['Misc'] }
  }).
  input(z.object({
    page: z.number().default(1),
    size: z.number().default(20),
    active: z.boolean().optional()
  })).
  output(z.object({ page: z.number(), size: z.number(), active: z.boolean().optional() })).
  query(async ({ input }) => input),

  // Endpoint with array query params
  search: authedProcedure.
  meta({
    openapi: { method: 'GET', path: '/v2/search', tags: ['Search'] }
  }).
  input(z.object({
    tags: z.array(z.string()).optional(),
    ids: z.array(z.number()).optional()
  })).
  output(z.object({ tags: z.array(z.string()).optional(), ids: z.array(z.number()).optional() })).
  query(async ({ input }) => input),

  // Unprotected endpoint (protect: false)
  publicInfo: t.procedure.
  meta({
    openapi: { method: 'GET', path: '/v2/public-info', protect: false, summary: 'Public info' }
  }).
  output(z.object({ version: z.string() })).
  query(async () => ({ version: '1.0.0' })),

  // POST with form-urlencoded support
  formSubmit: authedProcedure.
  meta({
    openapi: { method: 'POST', path: '/v2/form', tags: ['Misc'] }
  }).
  input(z.object({ name: z.string(), email: z.string() })).
  output(z.object({ ok: z.boolean() })).
  mutation(async () => ({ ok: true })),

  // Throws a non-TRPCError
  crasher: authedProcedure.
  meta({
    openapi: { method: 'GET', path: '/v2/crash', summary: 'Crashes' }
  }).
  output(z.object({ ok: z.boolean() })).
  query(async () => {
    throw new Error('unexpected boom');
  })
});