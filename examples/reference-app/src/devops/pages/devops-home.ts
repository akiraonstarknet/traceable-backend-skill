import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';

export function registerDevopsHome(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops', handlerFile: 'src/devops/pages/devops-home.ts', middleware: [requireAuth] },
    (c) => c.redirect('/devops/apis', 302),
  );
}
