// Every change to every recorded table, with who caused it and which request or
// run it came from. Filters compose and live in the URL, so the owner can send
// someone a link to exactly what they are looking at.

import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { layout, h } from '../layout.js';
import { loadManifests, driftBadge, query, when, sensitiveColumns, maskRow } from '../queries.js';

type AuditRow = {
  id: string; happened_at: string; table_schema: string; table_name: string;
  operation: string; record_id: string; row_before: Record<string, unknown> | null;
  row_after: Record<string, unknown> | null; changed_columns: string[] | null;
  actor: string; source: string; request_id: string | null; run_id: string | null;
  db_role: string;
};

export function registerDevopsAudit(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops/audit', handlerFile: 'src/devops/pages/devops-audit.ts', middleware: [requireAuth] },
    async (c) => {
      const filters = {
        table: c.req.query('table') ?? null,
        actor: c.req.query('actor') ?? null,
        source: c.req.query('source') ?? null,
        request_id: c.req.query('request_id') ?? null,
        run_id: c.req.query('run_id') ?? null,
        record_id: c.req.query('record_id') ?? null,
      };

      const where: string[] = [];
      const params: unknown[] = [];
      for (const [column, value] of Object.entries(filters)) {
        if (!value) continue;
        params.push(value);
        where.push(`${column === 'table' ? 'table_name' : column} = $${params.length}`);
      }

      const rows = await query<AuditRow>(
        `select id::text, happened_at::text, table_schema, table_name, operation,
                record_id::text, row_before, row_after, changed_columns, actor, source,
                request_id, run_id, db_role
           from audit.audit_log
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by happened_at desc, id desc limit 200`, params);

      const sensitive = sensitiveColumns(loadManifests().tables);

      const rendered = rows.map((r) => {
        const before = maskRow(r.row_before, r.table_name, sensitive);
        const after = maskRow(r.row_after, r.table_name, sensitive);
        const changed = (r.changed_columns ?? []).map((cn) => `<span class="tag">${h(cn)}</span>`).join('');
        const links = [
          r.request_id ? `request <code>${h(r.request_id)}</code>` : '',
          r.run_id ? `<a href="/devops/runs?run_id=${encodeURIComponent(r.run_id)}">run ${h(r.run_id)}</a>` : '',
        ].filter(Boolean).join(' &middot; ');

        return `<tr>
          <td>${h(when(r.happened_at))}</td>
          <td><code>${h(r.table_name)}</code></td>
          <td>${h(r.operation === 'INSERT' ? 'added' : r.operation === 'UPDATE' ? 'changed' : 'removed')}</td>
          <td>${changed || '<span class="muted">&mdash;</span>'}</td>
          <td>${h(r.actor)}<br><span class="muted">${h(r.source)} &middot; login ${h(r.db_role)}</span></td>
          <td>${links}<br>
              <a href="/devops/audit?record_id=${encodeURIComponent(r.record_id)}">this row&rsquo;s history</a></td>
          <td><details><summary>before / after</summary>
            <pre>${h(JSON.stringify(before, null, 2))}</pre>
            <pre>${h(JSON.stringify(after, null, 2))}</pre></details></td>
        </tr>`;
      }).join('');

      const body = `
        <h1>Audit</h1>
        <p class="lede">Every change the database recorded, newest first. The database writes
          these itself, so nothing can change data without appearing here. Personal fields are
          hidden on this page but kept in full underneath, so history stays answerable.</p>
        <form class="filters" method="get">
          <input name="table" placeholder="table" value="${h(filters.table ?? '')}">
          <input name="actor" placeholder="who" value="${h(filters.actor ?? '')}">
          <select name="source">
            <option value="">any source</option>
            ${['api', 'cron', 'run', 'migration', 'manual'].map((s) =>
              `<option ${s === filters.source ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input name="request_id" placeholder="request id" value="${h(filters.request_id ?? '')}">
          <input name="run_id" placeholder="run id" value="${h(filters.run_id ?? '')}">
          <button type="submit">Filter</button>
          <a href="/devops/audit">clear</a>
        </form>
        <table>
          <tr><th>When</th><th>Table</th><th>What</th><th>Fields changed</th>
              <th>Who</th><th>Came from</th><th>Detail</th></tr>
          ${rendered || '<tr><td colspan="7" class="muted">No changes match these filters.</td></tr>'}
        </table>`;

      return c.html(layout({ title: 'Audit', active: 'audit', driftBadge: driftBadge(), body }));
    },
  );
}
