// The page that justifies the whole design.
//
// A run is shown as a numbered list of what actually happened, not a graph. A
// graph asks the reader to trace arrows and infer which path was taken; a list
// reads top to bottom and every line names a real thing.

import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { layout, h } from '../layout.js';
import { loadManifests, driftBadge, query, when, ms, usd } from '../queries.js';

type RunRow = {
  run_id: string; job_name: string; status: string; trigger_source: string;
  triggered_by: string | null; request_id: string | null; error_message: string | null;
  started_at: string; duration_ms: number | null; total_cost_usd: string;
};

type StepRow = {
  step_index: number; step_type: string; step_name: string; display_name: string;
  description: string; status: string; input_json: unknown; output_json: unknown;
  gate_decision: string | null; gate_reason: string | null; next_step_name: string | null;
  error_message: string | null; duration_ms: number | null; node_kind: string | null;
  llm_model: string | null; llm_tokens_in: number | null; llm_tokens_out: number | null;
  llm_cost_usd: string | null; llm_provider_generation_id: string | null;
};

export function registerDevopsRuns(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops/runs', handlerFile: 'src/devops/pages/devops-runs.ts', middleware: [requireAuth] },
    async (c) => {
      const runId = c.req.query('run_id') ?? null;
      const job = c.req.query('job') ?? null;
      const status = c.req.query('status') ?? null;
      const badge = driftBadge();

      if (runId) {
        const [run] = await query<RunRow>(
          `select run_id, job_name, status, trigger_source, triggered_by, request_id,
                  error_message, started_at::text, duration_ms, total_cost_usd::text
             from traceable.runs where run_id = $1`, [runId]);
        if (!run) {
          return c.html(layout({
            title: 'Run not found', active: 'runs', driftBadge: badge,
            body: `<h1>Run not found</h1><p>No run with id <code>${h(runId)}</code>.</p>`,
          }), 404);
        }
        const steps = await query<StepRow>(
          `select step_index, step_type, step_name, display_name, description, status,
                  input_json, output_json, gate_decision, gate_reason, next_step_name,
                  error_message, duration_ms, node_kind, llm_model, llm_tokens_in,
                  llm_tokens_out, llm_cost_usd::text, llm_provider_generation_id
             from traceable.run_steps where run_id = $1 order by step_index`, [runId]);

        const jobManifest = loadManifests().jobs.find((j) => j.metadata.name === run.job_name);

        const rendered = steps.map((s) => {
          const failed = s.status === 'failed';
          const mark = failed ? '<span class="bad">failed</span>'
                     : s.status === 'running' ? '<span class="warn">did not finish</span>'
                     : '<span class="ok">&#10003;</span>';
          const llm = s.llm_model
            ? `<div class="meta">${h(s.llm_model)} &middot; ${h(s.llm_tokens_in ?? 0)} in &rarr; ${h(s.llm_tokens_out ?? 0)} out
               &middot; ${h(usd(s.llm_cost_usd))} &middot; <code>${h(s.llm_provider_generation_id ?? '')}</code></div>`
            : '';
          const why = s.gate_reason
            ? `<div class="why">&ldquo;${h(s.gate_reason)}&rdquo;</div>` : '';
          const route = s.gate_decision
            ? `<div class="meta">chose <code>${h(s.gate_decision)}</code>, went to ${h(s.next_step_name ?? 'END')}</div>` : '';
          const err = s.error_message ? `<div class="meta bad">${h(s.error_message)}</div>` : '';
          return `<div class="step">
            <div class="muted">${s.step_index}</div>
            <div><strong>${h(s.display_name)}</strong>
                 <span class="tag">${h(s.step_type === 'gate' ? 'decision' : s.node_kind ?? 'node')}</span></div>
            <div class="muted">${h(ms(s.duration_ms))}</div>
            <div>${mark}</div>
            ${why}${route}${llm}${err}
            <details class="meta"><summary>input and output</summary>
              <pre>${h(JSON.stringify(s.input_json, null, 2))}</pre>
              <pre>${h(JSON.stringify(s.output_json, null, 2))}</pre></details>
          </div>`;
        }).join('');

        const body = `
          <p><a href="/devops/runs">&larr; all runs</a></p>
          <h1>${h(jobManifest?.metadata.name ?? run.job_name)}
            <span class="${run.status === 'failed' ? 'bad' : 'ok'}">${h(run.status)}</span></h1>
          <p class="lede">${h(jobManifest?.metadata.description ?? '')}</p>
          <div class="panel">
            Run <code>${h(run.run_id)}</code> &middot; started ${h(when(run.started_at))} &middot;
            took ${h(ms(run.duration_ms))} &middot; model cost ${h(usd(run.total_cost_usd))}<br>
            Started by ${h(run.triggered_by ?? 'unknown')} (${h(run.trigger_source)})
            ${run.request_id ? `&middot; request <code>${h(run.request_id)}</code>` : ''}<br>
            <a href="/devops/audit?run_id=${encodeURIComponent(run.run_id)}">Every row this run changed</a>
            ${run.error_message ? `<p class="bad">${h(run.error_message)}</p>` : ''}
          </div>
          ${rendered}`;
        return c.html(layout({ title: `Run ${run.run_id}`, active: 'runs', driftBadge: badge, body }));
      }

      const where: string[] = [];
      const params: unknown[] = [];
      if (job) { params.push(job); where.push(`job_name = $${params.length}`); }
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      const runs = await query<RunRow>(
        `select run_id, job_name, status, trigger_source, triggered_by, request_id,
                error_message, started_at::text, duration_ms, total_cost_usd::text
           from traceable.runs
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by started_at desc limit 100`, params);

      const rows = runs.map((r) => `<tr>
        <td><a href="/devops/runs?run_id=${encodeURIComponent(r.run_id)}"><code>${h(r.run_id)}</code></a></td>
        <td>${h(r.job_name)}</td>
        <td class="${r.status === 'failed' ? 'bad' : r.status === 'running' ? 'warn' : 'ok'}">${h(r.status)}</td>
        <td>${h(r.trigger_source)}</td>
        <td>${h(r.triggered_by ?? '')}</td>
        <td>${h(when(r.started_at))}</td>
        <td>${h(ms(r.duration_ms))}</td>
        <td>${h(usd(r.total_cost_usd))}</td>
      </tr>`).join('');

      const body = `
        <h1>Runs</h1>
        <p class="lede">Every time a job ran, including the times it failed. Open one to see
          what it did step by step, which way each decision went and why.</p>
        <form class="filters" method="get">
          <input name="run_id" placeholder="run id" value="">
          <input name="job" placeholder="job name" value="${h(job ?? '')}">
          <select name="status">
            <option value="">any status</option>
            ${['succeeded', 'failed', 'running'].map((s) =>
              `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button type="submit">Filter</button>
        </form>
        <table>
          <tr><th>Run</th><th>Job</th><th>Status</th><th>Started by</th><th>Who</th>
              <th>When</th><th>Took</th><th>Model cost</th></tr>
          ${rows || '<tr><td colspan="8" class="muted">No runs yet.</td></tr>'}
        </table>`;

      return c.html(layout({ title: 'Runs', active: 'runs', driftBadge: badge, body }));
    },
  );
}
