// Route registry.
//
// Every endpoint is registered through defineApi(), which records the method,
// path, middleware names and handler file alongside registering it on Hono.
// runtime-facts.ts then cross-checks the registry against Hono's own app.routes,
// so a route added with app.get(...) directly is reported as route.undeclared
// instead of quietly existing.

import type { Hono, MiddlewareHandler, Handler } from 'hono';

export type RouteRecord = {
  method: string;
  path: string;
  middleware: string[];
  handler: string;
};

const routes: RouteRecord[] = [];

/** Middleware must carry a stable name so `auth: secured` is checkable. */
export type NamedMiddleware = MiddlewareHandler & { traceableName?: string };

export function defineApi(
  app: Hono,
  opts: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    /** Repo-relative path of the file that serves this route, matching spec.handler. */
    handlerFile: string;
    middleware?: NamedMiddleware[];
  },
  handler: Handler,
): void {
  const middleware = opts.middleware ?? [];
  routes.push({
    method: opts.method,
    path: opts.path,
    middleware: middleware.map((m) => m.traceableName ?? m.name ?? 'anonymous'),
    handler: opts.handlerFile,
  });
  // Hono types `on` with fixed-length handler tuples, so spreading a
  // variable-length middleware array does not match any overload. The runtime
  // implementation is variadic, so the chain is assembled first and the tuple
  // shape asserted. This is the only assertion in the project.
  const chain = [...middleware, handler] as unknown as [Handler];
  app.on(opts.method, opts.path, ...chain);
}

export function registeredRoutes(): RouteRecord[] {
  return routes;
}

export function resetRegistry(): void {
  routes.length = 0;
}
