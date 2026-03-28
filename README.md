# @tofupilot/trpc-rest

OpenAPI support for tRPC v11 — generate OpenAPI 3.1 specs and handle REST requests from tRPC routers.

Built for [Zod 4](https://zod.dev/) and [tRPC v11](https://trpc.io/).

## Install

```bash
npm install @tofupilot/trpc-rest
# or
pnpm add @tofupilot/trpc-rest
```

### Peer dependencies

```json
{
  "@trpc/server": ">=11.10.0",
  "zod": ">=4.0.0"
}
```

## Usage

### 1. Add OpenAPI metadata to your procedures

```ts
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import type { OpenApiMeta } from '@tofupilot/trpc-rest';

const t = initTRPC.meta<OpenApiMeta>().create();

const appRouter = t.router({
  getUser: t.procedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/users/{id}',
        summary: 'Get a user by ID',
      },
    })
    .input(z.object({ id: z.string() }))
    .output(z.object({ id: z.string(), name: z.string() }))
    .query(({ input }) => {
      return { id: input.id, name: 'John' };
    }),
});
```

### 2. Generate an OpenAPI document

```ts
import { generateOpenApiDocument } from '@tofupilot/trpc-rest';

const doc = generateOpenApiDocument(appRouter, {
  title: 'My API',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
});
```

### 3. Handle REST requests

```ts
import { createOpenApiFetchHandler } from '@tofupilot/trpc-rest';

// In your HTTP handler (e.g. Next.js route handler)
export async function GET(req: Request) {
  return createOpenApiFetchHandler({
    router: appRouter,
    endpoint: '/api',
    req,
    createContext: ({ req }) => ({}),
  });
}
```

## API

### `generateOpenApiDocument(router, options)`

Generates an OpenAPI 3.1.0 document from a tRPC router.

**Options:**
- `title` — API title
- `version` — API version
- `baseUrl` — Server URL
- `description` — API description
- `tags` — Tag names
- `securitySchemes` — OpenAPI security scheme definitions
- `filter` — Filter which procedures to include
- `extensions` — Add OpenAPI extensions (`x-*`) to operations
- `errorSchemas` — Configure reusable error response schemas

### `createOpenApiFetchHandler(options)`

Handles incoming HTTP requests as tRPC OpenAPI calls using the Fetch API.

**Options:**
- `router` — tRPC router
- `endpoint` — URL prefix (e.g. `/api`)
- `req` — Fetch `Request` object
- `createContext` — Context factory
- `responseMeta` — Custom response headers/status
- `onError` — Error callback

### `OpenApiMeta`

Type for procedure metadata:

```ts
{
  openapi?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    tags?: string[];
    summary?: string;
    description?: string;
    protect?: boolean;
    enabled?: boolean;
    deprecated?: boolean;
    errorResponses?: Record<number, string>;
  };
}
```

## Features

- OpenAPI 3.1.0 spec generation from tRPC routers
- Fetch API request handler with full middleware chain support
- Zod 4 schema → JSON Schema conversion via `zod-openapi`
- Path parameters, query parameters, and request body handling
- Automatic query parameter type coercion
- Security scheme support
- Error response customization with `$ref` support
- Operation extensions (`x-*`)

## License

MIT
