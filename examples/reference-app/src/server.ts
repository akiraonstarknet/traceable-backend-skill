import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { requestContext } from './middleware/request-context.js';
import { resetRegistry } from './traceable/registry.js';

import { registerHealthCheck } from './services/health/routes/health-check.js';
import { registerTenantList } from './services/tenant-admin/routes/tenant-list.js';
import { registerTenantGet } from './services/tenant-admin/routes/tenant-get.js';
import { registerTenantStatusUpdate } from './services/tenant-admin/routes/tenant-status-update.js';
import { registerDevopsHome } from './devops/pages/devops-home.js';
import { registerDevopsApis } from './devops/pages/devops-apis.js';
import { registerDevopsData } from './devops/pages/devops-data.js';
import { registerDevopsJobs } from './devops/pages/devops-jobs.js';
import { registerDevopsRuns } from './devops/pages/devops-runs.js';
import { registerDevopsAudit } from './devops/pages/devops-audit.js';
import { registerDevopsDrift } from './devops/pages/devops-drift.js';

/**
 * Builds the whole application. runtime-facts.ts calls this too, so the drift
 * checker sees exactly the routes the server serves - a route that exists only
 * in a comment does not appear, and one registered outside defineApi() does.
 */
export function buildApp(): Hono {
  resetRegistry();
  const app = new Hono();
  app.use('*', requestContext);

  registerHealthCheck(app);
  registerTenantList(app);
  registerTenantGet(app);
  registerTenantStatusUpdate(app);

  registerDevopsHome(app);
  registerDevopsApis(app);
  registerDevopsData(app);
  registerDevopsJobs(app);
  registerDevopsRuns(app);
  registerDevopsAudit(app);
  registerDevopsDrift(app);

  return app;
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/src\/)/, ''));
if (isEntry) {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: buildApp().fetch, port });
  console.log(`listening on http://localhost:${port} - DevOps UI at http://localhost:${port}/devops`);
}
