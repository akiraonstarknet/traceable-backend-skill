// Three states, and the third is the one people forget: "nobody looked" must
// never look like "clean".

import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { layout, h } from '../layout.js';
import { readDrift, driftBadge, when } from '../queries.js';

const WHAT_EACH_CHECK_COMPARES: Record<string, string> = {
  'route.missing': 'compares the endpoints the manifests declare against the routes the application actually registers',
  'route.undeclared': 'finds routes the application answers that no manifest describes',
  'route.auth-mismatch': 'compares the declared login requirement against the middleware actually on the route',
  'table.missing': 'compares the tables the manifests describe against the tables in the database',
  'table.undeclared': 'finds tables in the database that no manifest describes',
  'column.undeclared': 'finds columns that exist but have no explanation in the manifest',
  'column.missing': 'finds columns described in the manifest that the table does not have',
  'audit.trigger-missing': 'checks that every table marked as recorded really has its recording trigger attached',
  'grant.missing': 'checks each service and job actually has the database permissions its manifest declares',
  'grant.excess': 'finds database permissions no manifest justifies',
  'grant.forbidden': 'compares each actor&rsquo;s database permissions against the tables its manifest says it must not touch',
  'grant.owner-at-runtime': 'checks no service connects as the all-powerful owner login',
  'role.missing': 'checks the database login for each service and job exists',
  'job.schedule-mismatch': 'compares the schedule shown here against the schedule the application registered',
  'pipeline.step-missing': 'compares the steps a job declares against the steps it implements',
  'code.undeclared-table-access': 'reads the code and finds tables it touches that its manifest does not declare',
  'code.raw-query-forbidden': 'finds hand-written SQL that would hide which tables the code touches',
  'code.gate-side-effect': 'checks that decision steps cannot change anything',
};

export function registerDevopsDrift(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops/drift', handlerFile: 'src/devops/pages/devops-drift.ts', middleware: [requireAuth] },
    (c) => {
      const report = readDrift();
      const badge = driftBadge();

      if (!report) {
        const body = `
          <h1>Drift</h1>
          <p class="lede">This page compares what you have been told about the system against
            what the system actually does.</p>
          <div class="panel"><p class="warn">Nobody has run the check yet.</p>
            <p>Run <code>npm run drift</code>. Until then, nothing on the other pages has been
              verified against the database or the running application.</p></div>`;
        return c.html(layout({ title: 'Drift', active: 'drift', driftBadge: badge, body }));
      }

      const partial = !report.complete
        ? `<p class="warn">This was a partial check:
             ${report.db_checked ? '' : 'the database was not checked. '}
             ${report.runtime_checked ? '' : 'the running application was not checked. '}
             Treat the result as unverified.</p>`
        : '';

      const grouped = new Map<string, typeof report.findings>();
      for (const f of report.findings) {
        const key = f.manifest ?? 'not declared anywhere';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(f);
      }

      const findings = [...grouped.entries()].map(([file, group]) => `
        <h2><code>${h(file)}</code></h2>
        ${group.map((f) => `<div class="panel">
          <p><strong class="bad">${h(f.id)}</strong> &mdash; ${h(f.message)}</p>
          ${f.fix ? `<p><strong>To fix:</strong> ${h(f.fix)}</p>` : ''}
          <p class="muted">This check ${WHAT_EACH_CHECK_COMPARES[f.id] ?? 'compares a manifest claim against the running system'}.</p>
        </div>`).join('')}`).join('');

      const body = `
        <h1>Drift</h1>
        <p class="lede">This page compares what you have been told about the system against what
          the system actually does. There is no judgement involved: every check is a direct
          comparison against the database, the running application, or the code.</p>
        <div class="panel">
          ${report.ok
            ? `<p class="ok">${report.checks_run} checks, nothing disagrees.</p>`
            : `<p class="bad">${report.findings.length} thing(s) disagree, out of ${report.checks_run} checks.</p>`}
          <p class="muted">Last checked ${h(when(report.checked_at))}.</p>
          ${partial}
        </div>
        ${findings}`;

      return c.html(layout({ title: 'Drift', active: 'drift', driftBadge: badge, body }));
    },
  );
}
