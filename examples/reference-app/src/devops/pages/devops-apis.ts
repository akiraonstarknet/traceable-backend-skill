// Every endpoint, whether it needs a login, and what each one may and may not touch.
// Public endpoints sort first and are visually distinct: a public endpoint
// appearing unexpectedly is the thing most worth noticing on this page.

import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { layout, h } from '../layout.js';
import { loadManifests, driftBadge } from '../queries.js';

export function registerDevopsApis(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops/apis', handlerFile: 'src/devops/pages/devops-apis.ts', middleware: [requireAuth] },
    (c) => {
      const { apis } = loadManifests();
      const sorted = [...apis].sort((a, b) =>
        (a.spec.auth === b.spec.auth ? 0 : a.spec.auth === 'public' ? -1 : 1) ||
        a.spec.path.localeCompare(b.spec.path));

      const rows = sorted.map((api) => {
        const d = api.spec.data;
        const tag = (t: string, cls = '') => `<span class="tag ${cls}">${h(t)}</span>`;
        return `<tr>
          <td><code>${h(api.spec.method)}</code></td>
          <td><code>${h(api.spec.path)}</code><br><span class="muted">${h(api.metadata.description)}</span></td>
          <td>${h(api.spec.service)}</td>
          <td>${api.spec.auth === 'public'
              ? '<span class="warn">public &mdash; no login needed</span>'
              : '<span class="ok">needs a login</span>'}</td>
          <td>
            ${d.reads.length ? `reads ${d.reads.map((t: string) => tag(t)).join('')}<br>` : ''}
            ${d.writes.length ? `writes ${d.writes.map((t: string) => tag(t, 'write')).join('')}<br>` : ''}
            ${d.must_not_touch.length
              ? `cannot touch ${d.must_not_touch.map((t: string) => tag(t, 'forbidden')).join('')}`
              : ''}
          </td>
          <td class="muted"><code>${h(api.spec.handler)}</code></td>
        </tr>`;
      }).join('');

      const body = `
        <h1>APIs</h1>
        <p class="lede">Every request this application answers. &ldquo;Cannot touch&rdquo; means the
          database login used by that service has no permission on those tables &mdash; it is
          enforced by the database, not by a note in the code.</p>
        <table>
          <tr><th>Method</th><th>Path and what it does</th><th>Service</th><th>Login</th><th>Data</th><th>File</th></tr>
          ${rows}
        </table>`;

      return c.html(layout({ title: 'APIs', active: 'apis', driftBadge: driftBadge(), body }));
    },
  );
}
