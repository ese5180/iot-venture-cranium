/**
 * Who is calling, and what they may do.
 *
 * API Gateway has already verified the access token's signature, issuer, audience,
 * expiry and scope. This module checks what the gateway does not: that the token is an
 * access token of this console's app client, and which groups the caller is in.
 *
 * The gateway does not pass cognito:groups on as an array. It flattens the claim into
 * one string such as "[release-managers viewers]". parseGroups is the only place that
 * reads it, and group names are compared whole, never as substrings.
 *
 * A token is valid for up to an hour, so it cannot prove that its owner is still
 * allowed to change things. Every write therefore asks Cognito at that moment whether
 * the user is enabled, confirmed and a release manager, and Cognito's answer is the
 * one that counts: a user who lost the role cannot write with the old token, and a
 * user who was given it can write without signing in again.
 */

import { forbidden, unauthorized } from './http.mjs';

export const VIEWERS = 'viewers';
export const RELEASE_MANAGERS = 'release-managers';

// A Cognito sub is a UUID. Anything outside this set is not an identity of this pool.
const SUB = /^[A-Za-z0-9_.:-]{1,128}$/;

const EMAIL_CACHE_MS = 5 * 60 * 1000;

/**
 * The group names in a cognito:groups claim. Accepts a real array; otherwise strips
 * one leading "[" and one trailing "]" and splits on whitespace only.
 */
export function parseGroups(claim) {
  if (Array.isArray(claim)) {
    return claim.filter((name) => typeof name === 'string' && name !== '');
  }
  if (typeof claim !== 'string') return [];
  let text = claim;
  if (text.startsWith('[')) text = text.slice(1);
  if (text.endsWith(']')) text = text.slice(0, -1);
  return text.split(/\s+/).filter((name) => name !== '');
}

/** The claims the JWT authorizer attached to the request, or null. */
function claimsOf(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
}

/** The sub the request's token names, if it has a usable one. Proves nothing. */
export function claimedSub(event) {
  const sub = claimsOf(event)?.sub;
  return typeof sub === 'string' && SUB.test(sub) ? sub : '';
}

/**
 * Identify the caller, or throw 401. Fails closed: anything missing or unexpected is
 * a refusal.
 */
export function authenticate(event, userPoolClientId) {
  const claims = claimsOf(event);
  if (claims === null) throw unauthorized();
  if (typeof userPoolClientId !== 'string' || userPoolClientId === '') throw unauthorized();
  if (claims.token_use !== 'access' || claims.client_id !== userPoolClientId) throw unauthorized();
  if (typeof claims.sub !== 'string' || !SUB.test(claims.sub)) throw unauthorized();

  const groups = parseGroups(claims['cognito:groups']);
  return {
    sub: claims.sub,
    // Only the two groups of this console matter; other names are not echoed.
    groups: [RELEASE_MANAGERS, VIEWERS].filter((name) => groups.includes(name)),
    expiresAt: numericClaim(claims.exp),
  };
}

/** The gateway passes numeric claims on as strings. */
function numericClaim(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

/** An e-mail address as Cognito holds it, or '' if it is not fit to show or store. */
function displayEmail(value) {
  return typeof value === 'string' && value.length <= 320 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) ? value : '';
}

/** Every route is for members of the console's groups only. */
export function requireMember(caller) {
  if (caller.groups.length === 0) {
    throw forbidden('forbidden',
      'Your account has no access to this console. Ask a release manager to add you.');
  }
}

/**
 * The part of authorization that needs Cognito.
 *
 * @param {object} deps
 * @param {object} deps.aws    the AWS adapter (getUser, listUserGroups)
 * @param {() => number} deps.now
 */
export function createDirectory({ aws, now }) {
  const emails = new Map();

  function remember(sub, email) {
    if (emails.size >= 256) emails.clear();
    emails.set(sub, { email, at: now() });
  }

  /**
   * The caller's e-mail address for display. Cached for five minutes; an empty string
   * when Cognito cannot say. Never throws: the address is not needed for any decision.
   */
  async function emailOf(sub) {
    const cached = emails.get(sub);
    if (cached !== undefined && now() - cached.at < EMAIL_CACHE_MS) return cached.email;
    try {
      const user = await aws.getUser(sub);
      const email = user === null ? '' : displayEmail(user.email);
      remember(sub, email);
      return email;
    } catch {
      return '';
    }
  }

  /** The address if it was looked up in the last five minutes, else ''. Asks nobody. */
  function knownEmail(sub) {
    const cached = emails.get(sub);
    return cached !== undefined && now() - cached.at < EMAIL_CACHE_MS ? cached.email : '';
  }

  /**
   * Ask Cognito, now, whether this caller may change things: the account is enabled
   * and confirmed, and it is in the release-managers group. The groups in the token do
   * not decide this; they only choose the words of the refusal. Returns the user's
   * e-mail address, or throws 403. A failure to ask is a failure of the request.
   */
  async function requireLiveWriter(caller) {
    const [user, groups] = await Promise.all([aws.getUser(caller.sub), aws.listUserGroups(caller.sub)]);
    const email = user === null ? '' : displayEmail(user.email);
    if (user !== null) remember(caller.sub, email);
    if (user === null || user.enabled !== true || user.status !== 'CONFIRMED') {
      throw forbidden('account_inactive', 'Your account is disabled or not confirmed.');
    }
    if (!Array.isArray(groups) || !groups.includes(RELEASE_MANAGERS)) {
      throw forbidden('release_manager_required', caller.groups.includes(RELEASE_MANAGERS)
        ? 'You are no longer a release manager.'
        : 'Only release managers can do this.');
    }
    return email;
  }

  return { emailOf, knownEmail, requireLiveWriter };
}
