// Job registry. describe() is what the drift checker reads: it reports the
// shape the code actually implements, so a pipeline step that exists only in the
// manifest shows up as pipeline.step-missing rather than as documentation.

import type { JobDefinition } from '../traceable/types.js';
import { tenantStatusReview } from './tenant-status-review/index.js';

const jobs: JobDefinition[] = [tenantStatusReview];

export function allJobs(): JobDefinition[] {
  return jobs;
}

export function jobByName(name: string): JobDefinition | undefined {
  return jobs.find((j) => j.name === name);
}

export function describeJobs() {
  return jobs.map((job) => ({
    name: job.name,
    triggerType: job.triggerType,
    schedule: job.schedule,
    steps: job.steps.map((s) => ({
      name: s.name,
      type: s.type,
      kind: s.type === 'node' ? s.kind : null,
      model: s.type === 'node' ? (s.model ?? null) : null,
      routes: s.type === 'gate' ? s.routes : null,
      terminal: s.type === 'node' ? s.terminal === true : false,
    })),
  }));
}
