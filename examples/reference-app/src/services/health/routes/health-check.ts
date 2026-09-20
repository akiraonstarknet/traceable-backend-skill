// Public by design, and it touches no data at all. svc_health holds no grants
// on any table, so "must_not_touch: [tenants, tenant_status_history, users]" in
// its manifest is enforced by the absence of every grant, not by this comment.

import type { Hono } from 'hono';
import { defineApi } from '../../../traceable/registry.js';

export function registerHealthCheck(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/health', handlerFile: 'src/services/health/routes/health-check.ts' },
    (c) => c.json({ ok: true, time: new Date().toISOString() }),
  );
}
