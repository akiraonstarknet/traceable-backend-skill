// Every job, when it runs, the steps it is declared to take, and how its recent
// runs went. The declared pipeline is the shape; the Runs page is what happened.

import type { Hono } from 'hono';
import { defineApi } from '../../traceable/registry.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { layout, h } from '../layout.js';
import { loadManifests, driftBadge, query, when, ms, usd } from '../queries.js';

export function registerDevopsJobs(app: Hono): void {
  defineApi(
    app,
    { method: 'GET', path: '/devops/jobs', handlerFile: 'src/devops/pages/devops-jobs.ts', middleware: [requireAuth] },
    async (c) => {
      const { jobs } = loadManifests();

      const stats = await query<{
        job_name: string; runs: string; failures: string; last_started: string | null;
        last_status: string | null; cost: string | null;
      }>(`select job_name,
                 count(*)::text as runs,
                 count(*) filter (where status = 'failed')::text as failures,
                 max(started_at)::text as last_started,
                 (array_agg(status order by started_at desc))[1] as last_status,
                 coalesce(sum(total_cost_usd), 0)::text as cost
            from traceable.runs
           where started_at > now() - interval '30 days'
           group by job_name`);
      const byJob = new Map(stats.map((s) => [s.job_name, s]));

      const sections = jobs.map((job) => {
        const s = byJob.get(job.metadata.name);
        const trigger = job.spec.trigger.type === 'cron'
          ? `every day on the schedule <code>${h(job.spec.trigger.schedule)}</code> (${h(job.spec.trigger.timezone ?? 'UTC')})`
          : job.spec.trigger.type === 'api'
            ? 'started by an endpoint'
            : 'started by a person from this page';

        const steps = job.spec.pipeline.map((step: any, i: number) => {
          if (step.gate) {
            const routes = Object.entries(step.routes)
              .map(([label, target]) => `<code>${h(label)}</code> &rarr; ${h(target)}`).join(', ');
            return `<div class="step">
              <div class="muted">${i + 1}</div>
              <div><strong>${h(step.display_name)}</strong> <span class="tag">decision</span></div>
              <div class="muted">gate</div><div></div>
              <div class="why">${h(step.description)}</div>
              <div class="meta">goes to: ${routes}</div></div>`;
          }
          return `<div class="step">
            <div class="muted">${i + 1}</div>
            <div><strong>${h(step.display_name)}</strong>${
              step.kind === 'llm' ? ` <span class="tag">model: ${h(step.model)}</span>` : ''}</div>
            <div class="muted">${h(step.kind)}</div>
            <div>${step.terminal ? '<span class="muted">ends here</span>' : ''}</div>
            <div class="why">${h(step.description)}</div></div>`;
        }).join('');

        const d = job.spec.data;
        return `
          <h2>${h(job.metadata.name)}</h2>
          <p class="lede">${h(job.metadata.description)}</p>
          <p>Runs: ${trigger}. Code: <code>${h(job.spec.entrypoint)}</code></p>
          <div class="panel">
            <strong>Last 30 days</strong>
            ${s
              ? `<p>${h(s.runs)} run(s), ${h(s.failures)} failed. Last run ${h(when(s.last_started))}
                 &mdash; <span class="${s.last_status === 'failed' ? 'bad' : 'ok'}">${h(s.last_status)}</span>.
                 Model cost ${h(usd(s.cost))}.
                 <a href="/devops/runs?job=${encodeURIComponent(job.metadata.name)}">See the runs</a></p>`
              : '<p class="warn">This job has not run in the last 30 days.</p>'}
          </div>
          <p>Reads: ${d.reads.map((t: string) => `<span class="tag">${h(t)}</span>`).join('') || '<span class="muted">nothing</span>'}
             &nbsp; Writes: ${d.writes.map((t: string) => `<span class="tag write">${h(t)}</span>`).join('') || '<span class="muted">nothing</span>'}
             &nbsp; Cannot touch: ${d.must_not_touch.map((t: string) => `<span class="tag forbidden">${h(t)}</span>`).join('') || '<span class="muted">&mdash;</span>'}</p>
          <h3>Declared steps</h3>
          ${steps}`;
      }).join('');

      const body = `
        <h1>Jobs</h1>
        <p class="lede">What runs on its own, or when an endpoint asks. The steps below are what
          each job is declared to do; the Runs page shows what actually happened each time.</p>
        ${sections}`;

      return c.html(layout({ title: 'Jobs', active: 'jobs', driftBadge: driftBadge(), body }));
    },
  );
}
