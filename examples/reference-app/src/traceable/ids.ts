import { randomBytes } from 'node:crypto';

// Sortable-ish, readable ids. The owner is expected to quote these back
// ("run_k3f9..."), so they are prefixed by what they identify.
function id(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${time}${randomBytes(6).toString('hex')}`;
}

export const newRunId = () => id('run');
export const newRequestId = () => id('req');
export const newHistoryId = () => id('tsh');
export const newTenantId = () => id('t');
