import type { Hono } from 'hono';
import { defineApi } from '../../../traceable/registry.js';
import { requireAuth } from '../../../middleware/require-auth.js';
import { clientForActor } from '../../../traceable/db.js';
import { TENANT_ADMIN_DB } from '../db.js';

export function registerTenantList(app: Hono): void {
  defineApi(
    app,
    {
      method: 'GET',
      path: '/api/tenants',
      handlerFile: 'src/services/tenant-admin/routes/tenant-list.ts',
      middleware: [requireAuth],
    },
    async (c) => {
      const db = clientForActor(TENANT_ADMIN_DB);
      const tenants = await db.tenant.findMany({ orderBy: { updatedAt: 'desc' } });
      return c.json({
        tenants: tenants.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          suspendedReason: t.suspendedReason,
          updatedAt: t.updatedAt,
        })),
      });
    },
  );
}
