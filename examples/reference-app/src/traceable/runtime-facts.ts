// What the drift checker reads. It builds the real application and the real job
// registry in-process, so no server has to be listening - a check that needed a
// running server would be flaky in CI and would let a broken build silently skip
// its own verification.

import { buildApp } from '../server.js';
import { registeredRoutes } from './registry.js';
import { describeJobs } from '../jobs/registry.js';

export type RuntimeFacts = {
  routes: Array<{ method: string; path: string; middleware: string[]; handler?: string }>;
  jobs: ReturnType<typeof describeJobs>;
};

export function describeRuntime(): RuntimeFacts {
  const app = buildApp();
  const declared = registeredRoutes();
  const declaredKeys = new Set(declared.map((r) => `${r.method} ${r.path}`));

  // Hono's own route table, as the source of truth for what the server answers.
  // Anything here that did not come through defineApi() is reported with no
  // middleware, so it shows up as route.undeclared rather than going unnoticed.
  const bypassed = app.routes
    .filter((r) => r.method !== 'ALL')
    .map((r) => ({ method: r.method.toUpperCase(), path: r.path, middleware: [] as string[] }))
    .filter((r) => !declaredKeys.has(`${r.method} ${r.path}`));

  return { routes: [...declared, ...bypassed], jobs: describeJobs() };
}
