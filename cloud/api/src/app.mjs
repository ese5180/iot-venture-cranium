/**
 * The console API as one function: an API Gateway HTTP API event (payload format 2.0)
 * goes in, a response comes out.
 *
 * Every request takes the same path:
 *
 *   1. identify the caller from the claims the gateway verified   (401)
 *   2. require membership of one of the console's groups         (403)
 *   3. find the route                                             (404)
 *   4. for a write: require the release-managers group in the token, then ask
 *      Cognito whether that is still true right now               (403)
 *   5. validate the path and the body, then act
 *
 * A request to a write route leaves exactly one entry in the activity log, whatever
 * its outcome, including the refusals in steps 1, 2 and 4.
 *
 * Nothing here imports the AWS SDK. The adapter is passed in, so the same code runs
 * against AWS in Lambda and against test/fake-aws.mjs in tests and in the local preview.
 */

import { randomBytes } from 'node:crypto';

import {
  authenticate, claimedSub, createDirectory, requireMember, requireReleaseManager,
} from './auth.mjs';
import { createAuditHandlers } from './handlers/audit.mjs';
import { createDeploymentHandlers } from './handlers/deployments.mjs';
import { createDeviceHandlers } from './handlers/devices.mjs';
import { UPLOAD_BODY_LIMIT, createFirmwareHandlers } from './handlers/firmware.mjs';
import { createMeHandlers } from './handlers/me.mjs';
import {
  HttpError, SMALL_BODY_LIMIT, errorCode, errorResponse, json, notFound, readJsonObject,
} from './http.mjs';
import { REQUEST_ID } from './lib/audit.mjs';

const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_PATH = 512;

function route(method, path, run, write = null) {
  return Object.freeze({ method, name: `${method} ${path}`, segments: path.split('/').slice(1), run, write });
}

/**
 * The segments of the request path, each decoded once. Whether the gateway has
 * already decoded the path does not matter: every parameter is matched against a
 * strict grammar afterwards, and no valid value contains a "%" or a "/".
 */
function pathSegments(event) {
  const path = typeof event?.rawPath === 'string' ? event.rawPath : event?.requestContext?.http?.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH) return null;
  const segments = [];
  for (const raw of path.slice(1).split('/')) {
    if (!raw.includes('%')) {
      segments.push(raw);
      continue;
    }
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

function findRoute(routes, method, segments) {
  if (segments === null) return null;
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== segments.length) continue;
    const params = {};
    let matches = true;
    for (let index = 0; index < segments.length && matches; index += 1) {
      const pattern = candidate.segments[index];
      if (!pattern.startsWith('{')) matches = pattern === segments[index];
      else if (segments[index] === '') matches = false;
      else params[pattern.slice(1, -1)] = segments[index];
    }
    if (matches) return { route: candidate, params };
  }
  return null;
}

/** The request method if it is one of the usual ones; anything else is logged as OTHER. */
function methodOf(event) {
  const method = event?.requestContext?.http?.method;
  return typeof method === 'string' && METHODS.includes(method) ? method : 'OTHER';
}

function queryOf(event) {
  const query = event?.queryStringParameters;
  return query !== null && typeof query === 'object' && !Array.isArray(query) ? query : {};
}

/** How a failed write is recorded in the activity log. */
function outcomeOf(error) {
  if (!(error instanceof HttpError)) return 'error';
  if (error.status === 401 || error.status === 403) return 'denied';
  return error.status < 500 ? 'rejected' : 'error';
}

/**
 * @param {object} options
 * @param {object} options.aws      the AWS adapter (src/aws.mjs or test/fake-aws.mjs)
 * @param {object} options.config   the result of loadConfig (src/config.mjs)
 * @param {() => number|Date} [options.now]            the clock; epoch milliseconds
 * @param {(count: number) => string} [options.randomHex]  at least `count` lowercase hex
 *                                  characters from a CSPRNG
 * @param {(line: object) => void} [options.log]       receives each log line as an object
 * @returns {(event: object) => Promise<object>} the Lambda handler
 */
export function createApp({
  aws,
  config,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
}) {
  if (aws === undefined || aws === null) throw new TypeError('createApp needs an AWS adapter');
  if (config === undefined || config === null) throw new TypeError('createApp needs a configuration');

  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  const context = { aws, config, now: clock, randomHex, log };
  context.directory = createDirectory(context);

  const audit = createAuditHandlers(context);
  const devices = createDeviceHandlers(context);
  const deployments = createDeploymentHandlers(context, { devices });
  const firmware = createFirmwareHandlers(context, { deployments });
  const me = createMeHandlers(context);

  const routes = Object.freeze([
    route('GET', '/api/me', me.get),
    route('GET', '/api/devices', devices.list),
    route('GET', '/api/devices/{thing}', devices.get),
    route('GET', '/api/firmware', firmware.list),
    route('POST', '/api/firmware', firmware.upload, { action: 'firmware.upload', maxBody: UPLOAD_BODY_LIMIT }),
    route('GET', '/api/firmware/{version}', firmware.get),
    route('POST', '/api/firmware/{version}/revoke', firmware.revoke,
      { action: 'firmware.revoke', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/deployments', deployments.list),
    route('POST', '/api/deployments', deployments.create,
      { action: 'deployment.create', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/deployments/{id}', deployments.get),
    route('POST', '/api/deployments/{id}/cancel', deployments.cancel,
      { action: 'deployment.cancel', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/audit', audit.list),
  ]);

  async function read(found, event, seen) {
    const caller = authenticate(event, config.userPoolClientId);
    seen.sub = caller.sub;
    requireMember(caller);
    if (found === null) throw notFound('not_found', 'There is nothing at this address.');
    return found.route.run({ caller, params: found.params, query: queryOf(event) });
  }

  async function write(found, event, requestId, seen) {
    const { action, maxBody } = found.route.write;
    // The handler fills these in as it learns what the request is about.
    const entry = { target: '', detail: {} };
    const actor = { sub: claimedSub(event), email: '' };
    let result = null;
    let failure = null;
    try {
      const caller = authenticate(event, config.userPoolClientId);
      seen.sub = caller.sub;
      requireMember(caller);
      requireReleaseManager(caller);
      actor.email = await context.directory.requireLiveWriter(caller.sub);
      result = await found.route.run({
        caller,
        actor: { sub: caller.sub, email: actor.email },
        params: found.params,
        query: queryOf(event),
        entry,
        json: () => readJsonObject(event, maxBody),
      });
    } catch (error) {
      failure = error;
    }

    let outcome = 'ok';
    if (failure !== null) {
      outcome = outcomeOf(failure);
      entry.detail.code = errorCode(failure);
      // A refusal before the live check has no address yet; look it up for the record.
      if (actor.email === '' && seen.sub !== null) actor.email = await context.directory.emailOf(seen.sub);
    }
    const recorded = await audit.record({
      at: clock(), requestId, actor, action, target: entry.target, outcome, detail: entry.detail,
    });
    if (failure !== null) throw failure;
    if (!recorded) {
      throw new HttpError(500, 'audit_failed', 'The change was made, but it could not be written to ' +
        'the activity log. Check the result before you repeat it.');
    }
    return result;
  }

  /** The gateway's id for the request, or one made up here if there is no usable one. */
  function requestIdOf(event) {
    const given = event?.requestContext?.requestId;
    if (typeof given === 'string' && REQUEST_ID.test(given)) return given;
    const drawn = String(randomHex(16)).slice(0, 16);
    return /^[0-9a-f]{16}$/.test(drawn) ? drawn : randomBytes(8).toString('hex');
  }

  return async function handler(event) {
    const started = clock();
    const requestId = requestIdOf(event);
    const method = methodOf(event);
    const found = findRoute(routes, method, pathSegments(event));
    const seen = { sub: null };

    let response;
    try {
      const result = found !== null && found.route.write !== null
        ? await write(found, event, requestId, seen)
        : await read(found, event, seen);
      response = json(result.status ?? 200, result.body);
    } catch (error) {
      const failed = errorResponse(error, requestId);
      if (failed.internal !== null) {
        log({ level: 'error', event: 'request_failed', requestId, error: failed.internal });
      }
      response = failed.response;
    }

    log({
      requestId,
      sub: seen.sub,
      method,
      route: found === null ? 'unmatched' : found.route.name,
      status: response.statusCode,
      duration: clock() - started,
    });
    return response;
  };
}
