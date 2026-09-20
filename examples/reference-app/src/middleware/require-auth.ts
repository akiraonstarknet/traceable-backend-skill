// Demo authentication: a bearer token that names the person.
//
// Real projects swap the body of this for their identity provider. What matters
// to the drift checker is the NAME: `auth: secured` in a manifest is verified by
// looking for `requireAuth` in the route's middleware chain, so this middleware
// must keep a stable traceableName.

import type { MiddlewareHandler } from 'hono';

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return c.json({ error: 'authentication required' }, 401);
  }
  // Demo scheme: the token is the caller's email address.
  c.set('actor', `user:${token}`);
  await next();
  return;
};
Object.defineProperty(requireAuth, 'traceableName', { value: 'requireAuth' });
