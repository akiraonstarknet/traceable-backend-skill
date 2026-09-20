// Gives every request an id and an actor, and puts them on the Hono context.
// Handlers pass these into withContext(), which is how a database change ends
// up joined to the request that caused it on the Audit page.

import type { MiddlewareHandler } from 'hono';
import { newRequestId } from '../traceable/ids.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    actor: string;
  }
}

export const requestContext: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? newRequestId();
  c.set('requestId', requestId);
  // Set by requireAuth for secured routes; public routes stay anonymous and
  // cannot write anything, because their role holds no write grants.
  c.set('actor', c.get('actor') ?? 'anonymous');
  c.header('x-request-id', requestId);
  await next();
};
Object.defineProperty(requestContext, 'traceableName', { value: 'requestContext' });
