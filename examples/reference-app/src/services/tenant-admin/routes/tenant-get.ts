import type { Hono } from 'hono';
import { defineApi } from '../../../traceable/registry.js';
import { requireAuth } from '../../../middleware/require-auth.js';
import { clientForActor } from '../../../traceable/db.js';
import { TENANT_ADMIN_DB } from '../db.js';

export function registerTenantGet(app: Hono): void {
  defineApi(
    app,
    {
      method: 'GET',
      path: '/api/tenants/:tenantId',
      handlerFile: 'src/services/tenant-admin/routes/tenant-get.ts',
      middleware: [requireAuth],
    },
    async (c) => {
      const db = clientForActor(TENANT_ADMIN_DB);
      const tenantId = c.req.param('tenantId');
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) return c.json({ error: `no organisation with id ${tenantId}` }, 404);

      const history = await db.tenantStatusHistory.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      return c.json({ tenant, history });
    },
  );
}
