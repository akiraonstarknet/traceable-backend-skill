// Two-minute demo: one accepted change, one refused change, then the DevOps
// pages that show both. Runs in-process against the real app, so it exercises
// the same routes, roles and audit triggers the server does.

import { buildApp } from '../src/server.js';
import { disconnectAll } from '../src/traceable/db.js';

const app = buildApp();
const auth = { authorization: 'Bearer ada@example.com', 'content-type': 'application/json' };

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: auth,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as any };
  } catch {
    return { status: res.status, body: text };
  }
}

console.log('1. A suspension with a real reason\n');
const accepted = await call('POST', '/api/tenants/t_acme/status', {
  status: 'suspended',
  reason: 'Three invoices unpaid for more than ninety days despite two reminders.',
});
console.log(`   run ${accepted.body.runId} -> ${accepted.body.status}`);
console.log(`   applied: ${accepted.body.outcome?.applied}`);
console.log(`   tenant status is now: ${accepted.body.tenant?.status}\n`);

console.log('2. A suspension with a placeholder reason\n');
const refused = await call('POST', '/api/tenants/t_northwind/status', {
  status: 'suspended',
  reason: 'test',
});
console.log(`   run ${refused.body.runId} -> ${refused.body.status}`);
console.log(`   applied: ${refused.body.outcome?.applied}`);
console.log(`   tenant status is still: ${refused.body.tenant?.status}\n`);

console.log('3. A reactivation, which skips the model check\n');
const reactivated = await call('POST', '/api/tenants/t_globex/status', {
  status: 'active',
  reason: 'Outstanding balance cleared in full.',
});
console.log(`   run ${reactivated.body.runId} -> ${reactivated.body.status}`);
console.log(`   tenant status is now: ${reactivated.body.tenant?.status}\n`);

console.log('4. The public endpoint needs no login\n');
const health = await app.request('/health');
console.log(`   GET /health -> ${health.status} ${await health.text()}\n`);

console.log('5. Without a login, the secured endpoints refuse\n');
const denied = await app.request('/api/tenants');
console.log(`   GET /api/tenants (no token) -> ${denied.status}\n`);

console.log('6. The DevOps pages render\n');
for (const page of ['/devops/apis', '/devops/data', '/devops/jobs', '/devops/runs', '/devops/audit', '/devops/drift']) {
  const res = await app.request(page, { headers: auth });
  console.log(`   ${page.padEnd(16)} ${res.status}  ${(await res.text()).length} bytes`);
}

console.log(`\nOpen http://localhost:3000/devops/runs?run_id=${accepted.body.runId} after "npm start".`);
await disconnectAll();
