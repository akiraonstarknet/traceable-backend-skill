// Every table: what each column means, whether changes are recorded, and who is
// allowed to read or write it. "Who touches this" is derived from the API and
// job manifests, never declared on the table, so the two cannot disagree.

import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { layout, h } from '../layout.js';
import { loadManifests, actorsByTable, driftBadge, query } from '../queries.js';

export function registerDevopsData(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops/data', handlerFile: 'src/devops/pages/devops-data.ts', middleware: [requireAuth] },
    async (c) => {
      const manifests = loadManifests();
      const actors = actorsByTable(manifests);

      const live = await query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
        `select table_schema, table_name, column_name, data_type
           from information_schema.columns
          where table_schema in ('public','audit','traceable')`);
      const typeOf = new Map(live.map((r) => [`${r.table_schema}.${r.table_name}.${r.column_name}`, r.data_type]));

      const counts = await query<{ table_name: string; changes: string }>(
        `select table_name, count(*)::text as changes
           from audit.audit_log
          where happened_at > now() - interval '7 days'
          group by table_name`);
      const changeCount = new Map(counts.map((r) => [r.table_name, r.changes]));

      const sections = manifests.tables.map((t) => {
        const schema = t.spec.schema ?? 'public';
        const who = actors.get(t.metadata.name) ?? { uses: [], forbidden: [] };

        const cols = (t.spec.columns ?? []).map((col: any) => `<tr>
            <td><code>${h(col.name)}</code></td>
            <td class="muted"><code>${h(typeOf.get(`${schema}.${t.metadata.name}.${col.name}`) ?? '?')}</code></td>
            <td>${h(col.description)}</td>
            <td>${col.sensitivity && col.sensitivity !== 'internal'
                  ? `<span class="tag">${h(col.sensitivity)}</span>` : ''}</td>
          </tr>`).join('');

        const uses = who.uses.length
          ? who.uses.map((u) => `<li>${h(u.actor)} &mdash; ${h(u.access)} <span class="muted">(${h(u.file)})</span></li>`).join('')
          : '<li class="muted">nothing reads or writes this table</li>';
        const forbidden = who.forbidden.length
          ? `<p><strong>Forbidden for:</strong> ${who.forbidden.map((f) => h(f.actor)).join(', ')}
             &mdash; their database logins have no permission on this table.</p>`
          : '';

        return `
          <h2><code>${h(schema)}.${h(t.metadata.name)}</code></h2>
          <p class="lede">${h(t.metadata.description)}</p>
          <p>${t.spec.audited
              ? `<span class="ok">Changes recorded</span> &mdash; trigger <code>traceable_audit_${h(t.metadata.name)}</code>,
                 ${h(changeCount.get(t.metadata.name) ?? '0')} change(s) in the last 7 days
                 (<a href="/devops/audit?table=${encodeURIComponent(t.metadata.name)}">see them</a>)`
              : '<span class="muted">Changes not recorded &mdash; append-only infrastructure table</span>'}</p>
          <table>
            <tr><th>Column</th><th>Type</th><th>What it means</th><th></th></tr>
            ${cols}
          </table>
          <div class="panel"><strong>Who touches this table</strong><ul>${uses}</ul>${forbidden}</div>`;
      }).join('');

      const body = `
        <h1>Data</h1>
        <p class="lede">Every table, what its columns mean, and who is allowed near it.
          Column types come from the live database; the explanations come from the manifests.</p>
        ${sections}`;

      return c.html(layout({ title: 'Data', active: 'data', driftBadge: driftBadge(), body }));
    },
  );
}
