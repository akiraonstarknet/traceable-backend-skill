// This endpoint changes nothing itself. It validates the request and starts the
// tenant-status-review job, which may refuse the change.
//
// Its manifest declares writes: [] for exactly that reason, and svc_tenant_admin
// holds no INSERT, UPDATE or DELETE grant anywhere. The job runs as its own role,
// job_tenant_status_review, which does hold them.

import type { Hono } from 'hono';
import { defineApi } from '../../../traceable/registry.js';
import { requireAuth } from '../../../middleware/require-auth.js';
import { clientForActor } from '../../../traceable/db.js';
import { runJob } from '../../../traceable/runner.js';
import { createLlmClient } from '../../../traceable/llm.js';
import { tenantStatusReview } from '../../../jobs/tenant-status-review/index.js';
import { TENANT_ADMIN_DB } from '../db.js';

const JOB_DB = 'DATABASE_URL_JOB_TENANT_STATUS_REVIEW';

export function registerTenantStatusUpdate(app: Hono): void {
  defineApi(
    app,
    {
      method: 'POST',
      path: '/api/tenants/:tenantId/status',
      handlerFile: 'src/services/tenant-admin/routes/tenant-status-update.ts',
      middleware: [requireAuth],
    },
    async (c) => {
      const tenantId = c.req.param('tenantId');
      const body = await c.req.json().catch(() => null) as
        | { status?: string; reason?: string }
        | null;

      if (body?.status !== 'active' && body?.status !== 'suspended') {
        return c.json({ error: 'status must be "active" or "suspended"' }, 400);
      }
      if (typeof body.reason !== 'string' || !body.reason.trim()) {
        return c.json({ error: 'reason is required' }, 400);
      }

      const db = clientForActor(TENANT_ADMIN_DB);
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) return c.json({ error: `no organisation with id ${tenantId}` }, 404);

      const outcome = await runJob({
        job: tenantStatusReview,
        input: {
          tenantId,
          requestedStatus: body.status,
          reason: body.reason,
          requestedBy: c.get('actor'),
        },
        triggerSource: 'api',
        triggeredBy: c.get('actor'),
        requestId: c.get('requestId'),
        db: clientForActor(JOB_DB),
        llm: createLlmClient(),
      });

      const after = await db.tenant.findUnique({ where: { id: tenantId } });
      return c.json(
        {
          runId: outcome.runId,
          status: outcome.status,
          error: outcome.error,
          outcome: outcome.output,
          tenant: after,
          seeRun: `/devops/runs?run_id=${outcome.runId}`,
        },
        outcome.status === 'succeeded' ? 200 : 500,
      );
    },
  );
}
