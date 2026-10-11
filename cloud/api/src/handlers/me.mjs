/**
 * GET /api/me: who the console is talking to.
 *
 * The access token carries no e-mail address, so it is looked up in Cognito by the
 * token's sub (and cached for a few minutes). The groups and the expiry come from the
 * token; they tell the browser which controls to show and when the session ends. They
 * grant nothing: every write is checked again on the server.
 */

import { RELEASE_MANAGERS } from '../auth.mjs';

export function createMeHandlers({ directory }) {
  return {
    async get({ caller }) {
      return {
        body: {
          sub: caller.sub,
          email: await directory.emailOf(caller.sub),
          groups: caller.groups,
          canWrite: caller.groups.includes(RELEASE_MANAGERS),
          expiresAt: caller.expiresAt,
        },
      };
    },
  };
}
