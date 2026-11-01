/**
 * Local preview of the firmware console.
 *
 * It serves the real web console (web/src/server.mjs) and the real API
 * (api/src/app.mjs) on a loopback address, with the API wired to the in-memory
 * stand-in for AWS that the tests use (api/test/fake-aws.mjs). Nothing here talks to
 * AWS, and nothing here is packaged or deployed: it is a development tool for looking
 * at the console and trying its flows.
 *
 *   node cloud/dev/preview.mjs [--scenario <name>] [--viewer] [--live] [--port <number>]
 *                              [--repeated-cancel <refused|accepted|ignored>] [--home]
 *
 * What stands in for the parts that are AWS in production:
 *
 *   API Gateway    The routes of the HTTP API and its JWT authorizer. A request to
 *                  /api/ needs the access token that the sign-in below issued, and
 *                  reaches the API function as the event the gateway would build. What
 *                  no route claims goes to the web function, as it does when deployed.
 *   Cognito        The four addresses of the managed login that the console uses:
 *                  /oauth2/authorize, /oauth2/token, /oauth2/revoke and /logout. They
 *                  are served on the next port, so that they are another origin as in
 *                  production. There is no sign-in page and no password. The preview
 *                  has one user, a local release manager (--viewer: a local viewer),
 *                  and "authorize" signs that user in at once. The console's own
 *                  sign-in code runs unchanged: state, PKCE, token request, revocation.
 *   AWS IoT, S3,   api/test/fake-aws.mjs, which starts empty. AWS does not document
 *   DynamoDB       what a forced cancellation does to a deployment that was cancelled
 *                  before, without force, and still has a board at work. The stand-in
 *                  refuses it; --repeated-cancel makes it accept the call and stop
 *                  the board ("accepted"), or accept it and change nothing
 *                  ("ignored"), so that the console can be seen in all three cases.
 *   The boards     A model of what the firmware does (firmware/app/src/ota.c): it
 *                  writes its shadow and answers its job through the device helpers
 *                  of the stand-in. Its download fails once the image is revoked, as
 *                  it does when the bucket refuses a revoked image.
 *
 * The preview starts empty, or in the state a scenario built (--scenario <name>). A
 * scenario gets there the way a team would: boards are registered as the provisioning
 * tool registers them, and every upload, deployment and revocation is a request to
 * the real API handler. The firmware images are the fixtures of the API tests, and
 * the configured signing key is the fixture key they are signed with.
 *
 * Boards stay where the scenario left them and only keep reporting that they are
 * alive. With --live they act like boards: they pick up a new offer, notice a
 * cancellation, carry a started update through, and take their two buttons from the
 * terminal.
 *
 * The page is the one that is deployed. Nothing in web/ knows about the preview. With
 * --home the requests carry a host name that is on the web function's list of home page
 * names, so that the public home page is served by the same routing as when deployed.
 *
 * No dependencies.
 */

import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createApp } from '../api/src/app.mjs';
import { loadConfig } from '../api/src/config.mjs';
import { compareVersions, parseVersion } from '../api/src/lib/mcuboot.mjs';
import { accessClaims, createFakeAws, fakeEnv, fixture } from '../api/test/fake-aws.mjs';
import { createWebHandler } from '../web/src/server.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

// As deployed (infra/template.yaml): the scopes of the app client, the scope the API
// route demands, and how long an access token is valid. Cognito keeps an
// authorization code for five minutes.
const CLIENT_SCOPES = Object.freeze(['openid', 'cranium/console']);
const API_SCOPE = 'cranium/console';
const TOKEN_SECONDS = 3600;
const CODE_SECONDS = 300;

const WEB_ROOT = 'GET /';
const WEB_ASSETS = 'GET /assets/{proxy+}';
const WEB_DEFAULT = '$default';
const API_READ = 'GET /api/{proxy+}';
const API_WRITE = 'POST /api/{proxy+}';

// What the requests of --home are addressed to. A reserved domain: it can never exist.
const HOME_HOST = 'home.preview.invalid';

// The largest request an HTTP API accepts, and far more than a sign-in form needs.
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_FORM_BYTES = 16 * 1024;

// API Gateway hands a body to the function as text when its content type is a text
// type, and base64 encoded otherwise. The API reads both.
const TEXT_BODY = /^(?:text\/|application\/(?:json|xml|javascript)\b|application\/[\w.-]+\+(?:json|xml)\b)/i;
const FORM_BODY = /^application\/x-www-form-urlencoded\b/i;

// PKCE (RFC 7636): an S256 challenge is 43 characters, a verifier 43 to 128.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

// The firmware's heartbeat comes every 30 s, and a board counts as online for 90 s after one.
const HEARTBEAT_MS = 30_000;
// A board left to itself (--live): ten percent of the download every two seconds,
// and twelve seconds for the restart into the new firmware.
const LIVE_TICK_MS = 1000;
const LIVE_SECONDS_PER_STEP = 2;
const LIVE_RESTART_SECONDS = 12;

// What the stand-in can do with a forced cancellation of a deployment that is
// cancelled already (api/test/fake-aws.mjs). The first is what it does by default.
const REPEATED_CANCEL = Object.freeze(['refused', 'accepted', 'ignored']);

// A reserved domain that can never receive mail. The addresses exist only here.
const MAIL_DOMAIN = 'preview.invalid';

const USERS = Object.freeze({
  manager: Object.freeze({
    sub: '00000000-0000-4000-8000-000000000001',
    email: `manager@${MAIL_DOMAIN}`,
    groups: Object.freeze(['release-managers']),
    role: 'release manager',
  }),
  viewer: Object.freeze({
    sub: '00000000-0000-4000-8000-000000000002',
    email: `viewer@${MAIL_DOMAIN}`,
    groups: Object.freeze(['viewers']),
    role: 'viewer',
  }),
});

/** Something wrong with how the preview was started. The message is for the terminal. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * The preview has no real sign-in: whoever can reach it is a release manager. It
 * therefore listens on a loopback address and refuses any other.
 */
function requireLoopback(host) {
  if (typeof host !== 'string' || !isIPv4(host) || !host.startsWith('127.')) {
    throw new UsageError(`The preview only listens on a loopback address (127.x.x.x), not on "${host}": ` +
      'it has no real sign-in and must not be reachable from another computer.');
  }
}

/**
 * The preview's clock: the system clock, set back while a scenario is built, so that
 * what the scenario did lies in the hours before the preview started.
 */
function createClock(system) {
  let offset = 0;
  let latest = -Infinity;
  return {
    now: () => system() + offset,
    /**
     * Jump to `at` (epoch milliseconds, not in the future). The first jump goes back
     * to where the scenario begins; from there on time only moves forward.
     */
    moveTo(at) {
      if (at < latest) throw new RangeError('A scenario may only move forward in time');
      latest = at;
      offset = Math.min(0, at - system());
    },
    present() {
      offset = 0;
    },
  };
}

// Requests and responses.

/** The request target as path and query string, exactly as they were sent. */
function splitTarget(target) {
  const mark = target.indexOf('?');
  return mark === -1 ? [target, ''] : [target.slice(0, mark), target.slice(mark + 1)];
}

/** The whole request body, or null if it is larger than `limit` bytes. */
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(response, status, headers, body = '') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, { ...headers, 'content-length': bytes.length });
  response.end(bytes);
}

/** An answer of the gateway itself, in the form API Gateway gives its own answers. */
function sendGateway(response, status, message, headers = {}) {
  send(response, status, { 'content-type': 'application/json', ...headers }, JSON.stringify({ message }));
}

/** Send what a function returned, as API Gateway does. */
function sendResult(response, result) {
  const encoding = result.isBase64Encoded === true ? 'base64' : 'utf8';
  send(response, result.statusCode, result.headers ?? {}, Buffer.from(String(result.body ?? ''), encoding));
}

/**
 * The event API Gateway builds for a function (payload format 2.0), without the parts
 * that neither function reads, such as the account and the time.
 */
function gatewayEvent({ routeKey, method, path, query, headers, host, body = null, claims = null }) {
  const event = {
    version: '2.0',
    routeKey,
    rawPath: path,
    rawQueryString: query,
    headers,
    requestContext: {
      domainName: host,
      http: {
        method, path, protocol: 'HTTP/1.1', sourceIp: DEFAULT_HOST, userAgent: headers['user-agent'] ?? '',
      },
      // An id of the kind API Gateway gives each request.
      requestId: randomBytes(11).toString('base64'),
      routeKey,
      stage: '$default',
    },
    isBase64Encoded: false,
  };
  if (query !== '') {
    // One value per name; a name given twice has its values joined by a comma.
    const parameters = new Map();
    for (const [name, value] of new URLSearchParams(query)) {
      parameters.set(name, parameters.has(name) ? `${parameters.get(name)},${value}` : value);
    }
    event.queryStringParameters = Object.fromEntries(parameters);
  }
  if (claims !== null) event.requestContext.authorizer = { jwt: { claims, scopes: [API_SCOPE] } };
  if (body !== null && body.length > 0) {
    const text = TEXT_BODY.test(headers['content-type'] ?? '');
    event.body = body.toString(text ? 'utf8' : 'base64');
    event.isBase64Encoded = !text;
  }
  return event;
}

// Sign-in: the part of Cognito's managed login that the console uses.

/**
 * @param {object} options
 * @param {string} options.clientId        the app client the console signs in with
 * @param {() => string} options.host      host and port this stand-in is addressed by
 * @param {() => string} options.consoleOrigin  the origin that may read the replies
 * @param {() => string} options.redirectUri    the registered callback and sign-out address
 * @param {() => number} options.now       the clock, epoch milliseconds
 */
function createSignIn({ clientId, host, consoleOrigin, redirectUri, now }) {
  const codes = new Map();          // code -> { challenge, scopes, expiresAt }
  const sessions = new Map();       // access token -> { scopes, expiresAt }
  const refreshTokens = new Set();

  const seconds = () => Math.floor(now() / 1000);
  const secret = () => randomBytes(32).toString('base64url');
  const sealed = Object.freeze({
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });

  function forget() {
    for (const [code, grant] of codes) if (grant.expiresAt <= seconds()) codes.delete(code);
    for (const [token, session] of sessions) if (session.expiresAt <= seconds()) sessions.delete(token);
  }

  function page(response, status, text) {
    send(response, status, { ...sealed, 'content-type': 'text/plain; charset=utf-8' }, `${text}\n`);
  }

  function redirect(response, location) {
    send(response, 302, { ...sealed, location });
  }

  /**
   * An answer to the console's script, which runs on another origin and may read it:
   * like Cognito, the stand-in names the console's origin as the one that is allowed.
   */
  function reply(response, status, body) {
    send(response, status, {
      ...sealed,
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': consoleOrigin(),
      vary: 'origin',
    }, body === null ? '' : JSON.stringify(body));
  }

  function authorize(response, query) {
    const ask = new URLSearchParams(query);
    // An unknown client or return address gets an error page, as with Cognito: the
    // browser is never sent to an address that was not registered.
    if (ask.get('client_id') !== clientId || ask.get('redirect_uri') !== redirectUri()) {
      page(response, 400, 'This sign-in request does not name the console of this preview.');
      return;
    }
    const state = ask.get('state');
    const back = (fields) => redirect(response, `${redirectUri()}?${new URLSearchParams(fields)}`);
    const refuse = (error) => back(state === null ? { error } : { error, state });

    if (ask.get('response_type') !== 'code') {
      refuse('unsupported_response_type');
      return;
    }
    const scopes = (ask.get('scope') ?? '').split(' ').filter((scope) => scope !== '');
    if (scopes.length === 0 || scopes.some((scope) => !CLIENT_SCOPES.includes(scope))) {
      refuse('invalid_scope');
      return;
    }
    // Stricter than Cognito, which also takes a request without them: the console
    // must always send a state and an S256 challenge.
    const challenge = ask.get('code_challenge') ?? '';
    if (!state || ask.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(challenge)) {
      refuse('invalid_request');
      return;
    }

    // No sign-in page: the one user of the preview is signed in at once.
    forget();
    const code = secret();
    codes.set(code, { challenge, scopes, expiresAt: seconds() + CODE_SECONDS });
    back({ code, state });
  }

  function token(response, form) {
    if (form.get('grant_type') !== 'authorization_code') {
      reply(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    if (form.get('client_id') !== clientId) {
      reply(response, 400, { error: 'invalid_client' });
      return;
    }
    const code = form.get('code') ?? '';
    const grant = codes.get(code);
    // A code is good for one attempt, whatever comes of it.
    codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    const proven = grant !== undefined && VERIFIER.test(verifier) &&
      createHash('sha256').update(verifier).digest('base64url') === grant.challenge;
    if (!proven || grant.expiresAt <= seconds() || form.get('redirect_uri') !== redirectUri()) {
      reply(response, 400, { error: 'invalid_grant' });
      return;
    }

    forget();
    const accessToken = secret();
    const refreshToken = secret();
    sessions.set(accessToken, { scopes: grant.scopes, expiresAt: seconds() + TOKEN_SECONDS });
    refreshTokens.add(refreshToken);
    // Cognito answers with these five. The console wants only the access token.
    reply(response, 200, {
      id_token: secret(),
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: TOKEN_SECONDS,
      token_type: 'Bearer',
    });
  }

  function revoke(response, form) {
    if (form.get('client_id') !== clientId) {
      reply(response, 400, { error: 'invalid_client' });
      return;
    }
    // The access token stays good at the gateway, as in production: a JWT authorizer
    // checks signature and expiry and never asks Cognito about revocation.
    refreshTokens.delete(form.get('token') ?? '');
    reply(response, 200, null);
  }

  function signOut(response, query) {
    const ask = new URLSearchParams(query);
    if (ask.get('client_id') !== clientId || ask.get('logout_uri') !== redirectUri()) {
      page(response, 400, 'This sign-out request does not name the console of this preview.');
      return;
    }
    redirect(response, redirectUri());
  }

  return {
    async handle(request, response) {
      // Only requests addressed to this origin: a page elsewhere that points a host
      // name of its own at the loopback address is turned away.
      if (request.headers.host !== host()) {
        page(response, 403, 'Forbidden');
        return;
      }
      const [path, query] = splitTarget(request.url ?? '');
      const { method } = request;
      if (method === 'GET' && path === '/oauth2/authorize') {
        authorize(response, query);
      } else if (method === 'GET' && path === '/logout') {
        signOut(response, query);
      } else if (method === 'POST' && (path === '/oauth2/token' || path === '/oauth2/revoke')) {
        const body = FORM_BODY.test(request.headers['content-type'] ?? '')
          ? await readBody(request, MAX_FORM_BYTES)
          : null;
        if (body === null) {
          reply(response, 400, { error: 'invalid_request' });
          return;
        }
        const form = new URLSearchParams(body.toString('utf8'));
        if (path === '/oauth2/token') token(response, form);
        else revoke(response, form);
      } else {
        page(response, 404, 'Not found');
      }
    },

    /** The session an access token stands for, or null if it is unknown or has expired. */
    session(accessToken) {
      const session = sessions.get(accessToken);
      return session !== undefined && session.expiresAt > seconds() ? session : null;
    },

    /** How many refresh tokens were handed out and not revoked. The console leaves none. */
    refreshTokensLeft: () => refreshTokens.size,
  };
}

// Boards.

/** A name that looks like a real one and is the same on every run. */
function previewId(what, length) {
  return createHash('sha256').update(`cranium preview ${what}`).digest('hex').slice(0, length);
}

/**
 * A board, as far as the console can tell one from the outside. It does what the
 * firmware does (firmware/app/src/ota.c): it reports its state to its shadow on every
 * change, keeps an offered update queued until Button 1 is pressed, and asks AWS IoT
 * before it downloads and again before it installs.
 *
 * @param {object} fake      the stand-in for AWS; its device helpers are the board's side
 * @param {string} thing     the thing name
 * @param {string} version   the firmware the board was flashed with
 * @param {(text: string) => void} say   told what the board does, for the terminal
 */
function createBoard(fake, thing, version, say) {
  const board = {
    thing, version, powered: false, state: 'idle', job: null, target: null, progress: 0,
    last: 'none', error: '', rssi: -52,
  };
  let secondsInState = 0;
  // The object the offered image is stored under, from the job document.
  let imageKey = null;

  /** True if the bucket would refuse the image now: its release was revoked. */
  function imageRefused() {
    return fake.objects.get(imageKey)?.tags.revoked === 'true';
  }

  /** The whole reported document, as the firmware sends it every time. */
  function report(extra) {
    fake.device(thing).report({
      fw: { version: board.version, confirmed: true },
      // AWS IoT deletes a key whose value is null, so an idle board has no ota.job.
      ota: {
        state: board.state, job: board.job, progress: board.progress, last: board.last, error: board.error,
      },
      wifi: { rssi: board.rssi },
      ...extra,
    });
  }

  function enter(state) {
    board.state = state;
    secondsInState = 0;
  }

  /** Back to idle, remembering how the last update ended. */
  function settle(last, error) {
    enter('idle');
    board.job = null;
    board.target = null;
    board.progress = 0;
    board.last = last;
    board.error = error;
    report();
  }

  /** Send a job update. True if AWS IoT accepted it. */
  function update(status, details) {
    return fake.execution(board.job, thing).update(status, details).accepted;
  }

  /**
   * Ask AWS IoT for the next job, as the firmware does when it connects and whenever
   * it is told that its list of jobs changed.
   */
  function lookForJob() {
    if (!board.powered) return;
    const next = fake.device(thing).nextJob();
    if (board.job !== null && next?.jobId !== board.job) {
      // The job is no longer listed: it was cancelled, or it timed out.
      say(`${thing}: the update to ${board.target} was withdrawn`);
      settle('cancelled', '');
    }
    if (board.state !== 'idle' || next === null || next.status !== 'QUEUED') return;

    const offered = next.document?.fw?.version;
    board.job = next.jobId;
    if (next.document?.op !== 'fw_update' || parseVersion(offered) === null) {
      update('REJECTED', { reason: 'bad_document', running: board.version });
      settle('refused', 'bad_document');
    } else if (compareVersions(parseVersion(offered), parseVersion(board.version)) <= 0) {
      say(`${thing}: refused ${offered}, which is not newer than what it runs`);
      update('REJECTED', { reason: 'not_newer', running: board.version });
      settle('refused', 'not_newer');
    } else {
      // Nothing is sent to the job: the execution stays queued while the board waits.
      board.target = offered;
      imageKey = `firmware/${next.document.fw.sha256}.bin`;
      enter('awaiting_user');
      report();
      say(`${thing}: offered ${offered}, waiting for Button 1`);
    }
  }

  /** The update cannot go on: tell AWS IoT why, and go back to idle. */
  function fail(reason) {
    // If the job was cancelled meanwhile nobody takes this answer.
    update('FAILED', { reason, running: board.version });
    say(`${thing}: the update to ${board.target} failed (${reason})`);
    settle('failed', reason);
  }

  /** The download is complete: ask AWS IoT whether to go on, then restart. */
  function install() {
    enter('verifying');
    report();
    if (!update('IN_PROGRESS', { step: 'rebooting' })) {
      settle('cancelled', '');
      return false;
    }
    enter('rebooting');
    report();
    board.powered = false;
    say(`${thing}: downloaded and checked ${board.target}, restarting`);
    return true;
  }

  return Object.assign(board, {
    lookForJob,

    /** Power up and connect. `uptime`: seconds since the board started. */
    connect(uptime = 6) {
      board.powered = true;
      report({ uptime });
      lookForJob();
    },

    /** Lose power or the network. The shadow keeps what was reported last. */
    disconnect() {
      board.powered = false;
    },

    /**
     * Flashed over USB or serial, and back on the network: it runs something else, and
     * no job knows about it.
     */
    flash(flashed, uptime = 6) {
      board.version = flashed;
      board.last = 'none';
      board.error = '';
      report({ uptime });
    },

    /** The report a board sends when nothing has changed: its heartbeat. */
    heartbeat() {
      if (board.powered) report();
    },

    /** Button 1: install the update on offer. False if there is nothing to install. */
    pressButton1() {
      if (!board.powered || board.state !== 'awaiting_user') return false;
      // The firmware fetches the job again for a fresh download address, and
      // downloads only once AWS IoT has accepted that it starts.
      lookForJob();
      if (board.state !== 'awaiting_user') return false;
      if (!update('IN_PROGRESS', { step: 'downloading' })) {
        settle('cancelled', '');
        return false;
      }
      enter('downloading');
      report();
      say(`${thing}: Button 1 pressed, downloading ${board.target}`);
      return true;
    },

    /** Button 2: decline the update on offer. */
    pressButton2() {
      if (!board.powered || board.state !== 'awaiting_user') return false;
      update('REJECTED', { reason: 'declined', running: board.version });
      say(`${thing}: Button 2 pressed, ${board.target} declined`);
      settle('declined', '');
      return true;
    },

    /**
     * Go on downloading up to `percent`, reporting every ten percent. The bucket
     * refuses an image whose release was revoked, also in the middle of a download.
     */
    download(percent) {
      while (board.state === 'downloading' && board.progress < Math.min(percent, 100)) {
        if (imageRefused()) {
          fail('download_failed');
          return;
        }
        board.progress += 10;
        report();
      }
    },

    /** Check the finished download and restart into it. False if there is none. */
    install() {
      return board.state === 'downloading' && board.progress === 100 && install();
    },

    /**
     * Back from the restart. `kept` is false when the new firmware started but could
     * not reach AWS IoT, so that the bootloader put the previous firmware back.
     */
    comeBack({ kept, uptime = 6 }) {
      if (board.state !== 'rebooting') return;
      board.powered = true;
      if (kept) board.version = board.target;
      // If the job was cancelled meanwhile nobody takes this answer; the board runs
      // what it runs all the same.
      update(kept ? 'SUCCEEDED' : 'FAILED',
        kept ? { running: board.version } : { reason: 'rolled_back', running: board.version });
      say(kept
        ? `${thing}: runs ${board.version} and has confirmed it`
        : `${thing}: the bootloader put ${board.version} back`);
      enter('idle');
      board.job = null;
      board.target = null;
      board.progress = 0;
      board.last = kept ? 'succeeded' : 'rolled_back';
      board.error = kept ? '' : 'not confirmed';
      report({ uptime });
    },

    /** One second in the life of a board that is left to itself (--live). */
    tick() {
      secondsInState += 1;
      if (!board.powered) {
        if (board.state === 'rebooting' && secondsInState >= LIVE_RESTART_SECONDS) {
          board.comeBack({ kept: true });
        }
        return;
      }
      lookForJob();
      if (board.state === 'downloading' && secondsInState % LIVE_SECONDS_PER_STEP === 0) {
        board.download(board.progress + 10);
        if (board.progress === 100) install();
      }
    },
  });
}

/**
 * A line typed in the terminal while the boards are live: "1" or "2" presses that
 * button on the board that is waiting. With several waiting, the end of a board's
 * name says which one, as in "1 3f2a". Returns what to print, or null.
 */
function pressButton(boards, line) {
  const [button, suffix = ''] = line.trim().split(/\s+/);
  if (button === '') return null;
  if (button !== '1' && button !== '2') {
    return `"${button}" is not a button: a board has Button 1 and Button 2.`;
  }
  const waiting = boards.filter((board) => board.powered && board.state === 'awaiting_user');
  if (waiting.length === 0) {
    return 'No board is waiting for a button. Start a deployment in the console first.';
  }
  const chosen = waiting.filter((board) => board.thing.endsWith(suffix));
  if (chosen.length !== 1) {
    return `Which board? Add the end of its name: ${waiting.map((board) => board.thing).join(', ')}.`;
  }
  if (button === '1') chosen[0].pressButton1();
  else chosen[0].pressButton2();
  return null;
}

// Scenarios.

const SECONDS_IN = Object.freeze({ d: 86400, h: 3600, m: 60, s: 1 });

/** "2h50m" in milliseconds. */
function duration(text) {
  if (!/^(?:\d+[dhms])+$/.test(text)) throw new TypeError(`Not a length of time: ${text}`);
  let seconds = 0;
  for (const [, count, unit] of text.matchAll(/(\d+)([dhms])/g)) seconds += Number(count) * SECONDS_IN[unit];
  return seconds * 1000;
}

/**
 * What a scenario is built with: the clock, the provisioning of boards, and the
 * release manager's requests to the real API. A request that does not end the way
 * the scenario expects stops the preview from starting.
 */
function createStage({ fake, clock, boards, callApi, say }) {
  const begun = clock.now();

  async function request(method, path, body, expected) {
    const result = await callApi({
      method,
      path,
      user: USERS.manager,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
    });
    const answer = JSON.parse(result.body);
    const outcome = result.statusCode === 200 || result.statusCode === 201 ? 'ok' : answer.error?.code;
    if (outcome !== expected) {
      throw new Error(`The scenario could not be built: ${method} ${path} answered ` +
        `${result.statusCode} ${outcome}, not ${expected}`);
    }
    return answer;
  }

  // A build always produces zephyr.signed.bin, whatever the fixture is called.
  const image = (file, notes) =>
    ({ filename: 'zephyr.signed.bin', notes, data: fixture(file).toString('base64') });

  return {
    /** Go to the moment that lay this long before the preview started, e.g. "2h50m". */
    ago(text) {
      clock.moveTo(begun - duration(text));
    },

    /** What tools/provision_device.py does: a thing in the group, with its certificate. */
    provision(number, version) {
      const thing = `cranium-${previewId(`board ${number}`, 16)}`;
      fake.addThing(thing, { certificates: [previewId(`certificate ${number}`, 64)] });
      const board = createBoard(fake, thing, version, say);
      boards.push(board);
      return board;
    },

    async upload(file, notes) {
      await request('POST', '/api/firmware', image(file, notes), 'ok');
    },

    /** An upload that the server has to refuse with the given code. */
    async refusedUpload(file, code) {
      await request('POST', '/api/firmware', image(file, ''), code);
    },

    async deploy(version, targets, note) {
      const things = targets.map((board) => board.thing);
      return (await request('POST', '/api/deployments', { version, things, note }, 'ok')).deployment.id;
    },

    async cancel(id, force = false) {
      await request('POST', `/api/deployments/${id}/cancel`, { force }, 'ok');
    },

    /** A job made directly in AWS IoT, which ended before anyone looked: the console had no part in it. */
    async outsideJob(name, board, status, details) {
      const jobId = `cranium-bench-${name}`;
      await fake.createJob({
        jobId, things: [board.thing], document: '{}', description: '{}', urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
      });
      fake.execution(jobId, board.thing).update(status, { running: board.version, ...details });
    },

    /** A job made directly in AWS IoT that offers a board a version: the console has no part in it. */
    async outsideOffer(name, board, version) {
      await fake.createJob({
        jobId: `cranium-bench-${name}`,
        things: [board.thing],
        document: JSON.stringify({ op: 'fw_update', fw: { version, sha256: '0'.repeat(64) } }),
        description: '{}',
        urlExpiresInSec: 600,
        inProgressTimeoutMinutes: 30,
      });
    },

    async revoke(version, reason) {
      await request('POST', `/api/firmware/${version}/revoke`, { reason }, 'ok');
    },
  };
}

/** One board, flashed with 1.2.3+4 three hours ago, and a newer release ready for it. */
async function oneBoard(stage) {
  stage.ago('3h');
  const board = stage.provision(1, '1.2.3+4');
  board.connect();
  stage.ago('2h50m');
  await stage.upload('valid-1.2.3+4.signed.bin', 'The build the boards were flashed with over USB.');
  stage.ago('25m');
  await stage.upload('valid-1.2.3+5.signed.bin', 'Reconnects faster after the Wi-Fi drops out.');
  return board;
}

/** The release is deployed, and the board has seen the offer. */
async function offered(stage) {
  const board = await oneBoard(stage);
  stage.ago('6m');
  await stage.deploy('1.2.3+5', [board], 'First update over the air.');
  stage.ago('5m55s');
  board.lookForJob();
  return board;
}

/** Button 1 was pressed, the download went through, and the board restarted. */
async function restarted(stage) {
  const board = await offered(stage);
  stage.ago('5m');
  board.pressButton1();
  stage.ago('4m30s');
  board.download(100);
  board.install();
  return board;
}

/**
 * One board with a past, as a real one has: an update it declined, one that was cancelled
 * before it started and one it installed, jobs made directly in AWS IoT, and then 1.3.0+0
 * over USB, which is newer than every release and is not one of them.
 */
async function flashedOverUsb(stage) {
  const board = await oneBoard(stage);
  stage.ago('24m');
  await stage.deploy('1.2.3+5', [board], 'Declined on the board.');
  stage.ago('23m');
  board.lookForJob();
  board.pressButton2();
  stage.ago('21m');
  const cancelled = await stage.deploy('1.2.3+5', [board], 'Cancelled before the board started.');
  stage.ago('20m');
  await stage.cancel(cancelled);
  stage.ago('19m');
  await stage.outsideJob('20261010T100000-0a0a', board, 'FAILED', { reason: 'download_failed' });
  stage.ago('18m');
  await stage.outsideJob('20261010T101000-0b0b', board, 'SUCCEEDED', {});
  stage.ago('15m');
  await stage.deploy('1.2.3+5', [board], 'Installed.');
  stage.ago('14m50s');
  board.lookForJob();
  stage.ago('14m');
  board.pressButton1();
  stage.ago('13m30s');
  board.download(100);
  board.install();
  stage.ago('11m');
  board.comeBack({ kept: true });
  stage.ago('6m');
  board.flash('1.3.0+0');
  return board;
}

export const SCENARIOS = Object.freeze({
  empty: {
    summary: 'Nothing is registered yet: every page shows its empty state.',
    async build() {},
  },
  'one-board-idle': {
    summary: 'One board is online and idle on 1.2.3+4; release 1.2.3+5 is ready to deploy.',
    build: oneBoard,
  },
  'waiting-for-button': {
    summary: 'The board has been offered 1.2.3+5 and waits for its Button 1.',
    build: offered,
  },
  downloading: {
    summary: 'Button 1 was pressed; the board has downloaded 40% of 1.2.3+5.',
    async build(stage) {
      const board = await offered(stage);
      stage.ago('40s');
      board.pressButton1();
      stage.ago('20s');
      board.download(40);
    },
  },
  'lost-during-download': {
    summary: 'Button 1 was pressed and the download reached 40%; then the board went offline.',
    async build(stage) {
      const board = await offered(stage);
      stage.ago('5m');
      board.pressButton1();
      stage.ago('4m30s');
      board.download(40);
      board.disconnect();
    },
  },
  'outside-job': {
    summary: 'The board is downloading 1.2.3+5 from a job made directly in AWS IoT: no deployment of this console.',
    async build(stage) {
      const board = await oneBoard(stage);
      stage.ago('2m');
      await stage.outsideOffer('20261010T100000-0a0a', board, '1.2.3+5');
      board.lookForJob();
      board.pressButton1();
      stage.ago('40s');
      board.download(40);
    },
  },
  'rolled-back': {
    summary: 'The board installed 1.2.3+5, could not reconnect, and is back on 1.2.3+4.',
    async build(stage) {
      const board = await restarted(stage);
      stage.ago('2m');
      board.comeBack({ kept: false, uptime: 9 });
    },
  },
  succeeded: {
    summary: 'The board installed 1.2.3+5 and confirmed it.',
    async build(stage) {
      const board = await restarted(stage);
      stage.ago('3m40s');
      board.comeBack({ kept: true, uptime: 8 });
    },
  },
  'gone-offline': {
    summary: 'The board installed 1.2.3+5 and confirmed it, and has been offline since.',
    async build(stage) {
      const board = await restarted(stage);
      stage.ago('3m40s');
      board.comeBack({ kept: true, uptime: 8 });
      board.disconnect();
    },
  },
  'flashed-over-usb': {
    summary: 'After some deployments the board was flashed over USB with 1.3.0+0, which is not a registered release.',
    build: flashedOverUsb,
  },
  'flashed-then-offline': {
    summary: 'The same, and the board has been offline since it reported 1.3.0+0.',
    async build(stage) {
      const board = await flashedOverUsb(stage);
      board.disconnect();
    },
  },
  revoked: {
    summary: 'Three boards and a longer history: 2.0.0+0 was revoked while it was being rolled out.',
    async build(stage) {
      stage.ago('2d3h');
      const first = stage.provision(1, '1.2.3+4');
      const second = stage.provision(2, '1.2.3+4');
      second.rssi = -71;
      first.connect();
      second.connect();
      stage.ago('1d2h');
      await stage.upload('valid-1.2.3+4.signed.bin', 'The build the boards were flashed with over USB.');

      // Someone picks the wrong file, then the right one, and rolls it out. One
      // board installs it; on the other, Button 2 is pressed.
      stage.ago('5h');
      await stage.refusedUpload('signed-with-other-key.signed.bin', 'wrong_key');
      stage.ago('4h58m');
      await stage.upload('valid-1.2.3+5.signed.bin', 'Reconnects faster after the Wi-Fi drops out.');
      stage.ago('4h50m');
      await stage.deploy('1.2.3+5', [first, second], 'First update over the air.');
      stage.ago('4h49m');
      first.lookForJob();
      second.lookForJob();
      stage.ago('4h47m');
      first.pressButton1();
      second.pressButton2();
      stage.ago('4h46m');
      first.download(100);
      first.install();
      stage.ago('4h45m');
      first.comeBack({ kept: true });

      // The next release turns out to be faulty while both boards are being updated.
      stage.ago('40m');
      await stage.upload('valid-padded-signature.signed.bin', 'New pad layout.');
      stage.ago('36m');
      await stage.deploy('2.0.0+0', [first, second], 'Roll out 2.0.0 to both boards.');
      stage.ago('35m30s');
      first.lookForJob();
      second.lookForJob();
      stage.ago('34m');
      second.pressButton1();
      stage.ago('33m30s');
      second.download(30);
      stage.ago('33m');
      await stage.revoke('2.0.0+0', 'Pads stop responding after a few minutes of use.');
      stage.ago('32m55s');
      first.lookForJob();
      second.lookForJob();

      // One board has been switched off since. A third is registered and has never
      // been powered up.
      stage.ago('30m');
      second.heartbeat();
      second.disconnect();
      stage.ago('20m');
      stage.provision(3, '1.2.3+4');
    },
  },
});

// The preview itself.

/**
 * Start listening, then build the scenario.
 *
 * @param {object} [options]
 * @param {string} [options.scenario]   a name from SCENARIOS
 * @param {boolean} [options.viewer]    sign in as the local viewer, not the release manager
 * @param {boolean} [options.live]      let the boards act by themselves
 * @param {boolean} [options.home]      serve the public home page instead of the console
 * @param {string} [options.repeatedCancel]  what the stand-in does with a forced
 *                                      cancellation of a deployment that is cancelled
 *                                      already: "refused", "accepted" or "ignored"
 * @param {string} [options.host]       a loopback address
 * @param {number} [options.port]       the console's port; sign-in is served on the next
 *                                      one. 0 takes two free ports
 * @param {(line: object) => void} [options.log]   receives the log lines of both functions
 * @param {(text: string) => void} [options.say]   told what the boards do
 * @param {() => number} [options.now]  the clock, epoch milliseconds
 */
export async function createPreview({
  scenario = 'empty', viewer = false, live = false, home = false, repeatedCancel = 'refused', host = DEFAULT_HOST,
  port = DEFAULT_PORT, log = () => {}, say = () => {}, now = Date.now,
} = {}) {
  requireLoopback(host);
  if (!Object.hasOwn(SCENARIOS, scenario)) {
    throw new UsageError(
      `There is no scenario "${scenario}". Choose from: ${Object.keys(SCENARIOS).join(', ')}.`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65534) {
    throw new UsageError('The port must be a number from 0 to 65534.');
  }
  if (!REPEATED_CANCEL.includes(repeatedCancel)) {
    throw new UsageError(`--repeated-cancel takes one of: ${REPEATED_CANCEL.join(', ')}.`);
  }

  const user = viewer ? USERS.viewer : USERS.manager;
  const clock = createClock(now);
  const fake = createFakeAws({ now: clock.now, repeatedCancel });
  const config = loadConfig(fakeEnv());
  const app = createApp({
    aws: fake, config, now: clock.now, log: (line) => log({ function: 'api', ...line }),
  });
  for (const { sub, email, groups } of Object.values(USERS)) {
    fake.addUser({ sub, email, groups: [...groups] });
  }

  const boards = [];
  const timers = [];
  let consoleHost = null;
  let loginHost = null;
  let web = null;
  let terminal = null;
  // Silent while the scenario is built; afterwards the terminal hears what boards do.
  let narrate = () => {};

  const signIn = createSignIn({
    clientId: config.userPoolClientId,
    host: () => loginHost,
    consoleOrigin: () => `http://${consoleHost}`,
    redirectUri: () => `http://${consoleHost}/`,
    now,
  });

  /** Hand a request to the API function, as the gateway does once its authorizer is satisfied. */
  function callApi({ method, path, query = '', headers = {}, body = null, user: caller, expiresAt }) {
    const claims = accessClaims({
      sub: caller.sub,
      groups: caller.groups,
      clientId: config.userPoolClientId,
      exp: expiresAt ?? Math.floor(now() / 1000) + TOKEN_SECONDS,
    });
    return app(gatewayEvent({
      routeKey: method === 'GET' ? API_READ : API_WRITE, method, path, query, headers, host: consoleHost, body, claims,
    }));
  }

  /** The console's origin: what API Gateway is in production. */
  async function gateway(request, response) {
    if (request.headers.host !== consoleHost) {
      sendGateway(response, 403, 'Forbidden');
      return;
    }
    if (web === null) {
      sendGateway(response, 503, 'Service Unavailable');
      return;
    }
    const [path, query] = splitTarget(request.url ?? '');
    const { method, headers } = request;

    // The routes of the HTTP API. As deployed, {proxy+} also matches nothing at all
    // after the slash: /api/ reaches the authorizer, /api does not. The API takes only
    // these two methods, and what no route claims goes to the web function.
    let routeKey = WEB_DEFAULT;
    if (method === 'GET' && path === '/') routeKey = WEB_ROOT;
    else if (method === 'GET' && path.startsWith('/assets/')) routeKey = WEB_ASSETS;
    else if (method === 'GET' && path.startsWith('/api/')) routeKey = API_READ;
    else if (method === 'POST' && path.startsWith('/api/')) routeKey = API_WRITE;

    if (routeKey !== API_READ && routeKey !== API_WRITE) {
      const event = gatewayEvent({ routeKey, method, path, query, headers, host: home ? HOME_HOST : consoleHost });
      sendResult(response, await web(event));
    } else {
      // The JWT authorizer: a valid token that carries the scope of the route. The
      // token may come with or without the word Bearer.
      const session = signIn.session(String(headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (session === null) {
        sendGateway(response, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
        return;
      }
      if (!session.scopes.includes(API_SCOPE)) {
        sendGateway(response, 403, 'Forbidden');
        return;
      }
      const body = await readBody(request, MAX_REQUEST_BYTES);
      if (body === null) {
        sendGateway(response, 413, 'Request Entity Too Large', { connection: 'close' });
        return;
      }
      sendResult(response,
        await callApi({ method, path, query, headers, body, user, expiresAt: session.expiresAt }));
    }
  }

  /** Answer a request, or say what API Gateway says when a function fails. */
  const serve = (handle) => (request, response) => {
    handle(request, response).catch((error) => {
      log({ level: 'error', event: 'preview_failed', error: String(error?.stack ?? error) });
      if (response.headersSent) response.destroy();
      else sendGateway(response, 500, 'Internal Server Error');
    });
  };

  function listen(server, onPort) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port: onPort, exclusive: true }, () => {
        server.off('error', reject);
        // Whatever was asked for: nothing is served from an address other than this one.
        const bound = server.address();
        if (bound.address === host) resolve(bound.port);
        else reject(new Error(`Listening on ${bound.address}, not on ${host}`));
      });
    });
  }

  const consoleServer = createServer(serve(gateway));
  const loginServer = createServer(serve(signIn.handle));

  async function stop() {
    for (const timer of timers) clearInterval(timer);
    terminal?.close();
    for (const server of [consoleServer, loginServer]) {
      if (!server.listening) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  try {
    consoleHost = `${host}:${await listen(consoleServer, port)}`;
    loginHost = `${host}:${await listen(loginServer, port === 0 ? 0 : port + 1)}`;
    await SCENARIOS[scenario].build(
      createStage({ fake, clock, boards, callApi, say: (text) => narrate(text) }));
  } catch (error) {
    await stop();
    if (error?.code !== 'EADDRINUSE') throw error;
    throw new UsageError(`Port ${port} or ${port + 1} on ${host} is in use. Choose another with --port.`);
  }
  clock.present();
  for (const board of boards) board.heartbeat();
  narrate = say;

  // From here on requests are answered.
  web = createWebHandler({
    clientId: config.userPoolClientId,
    loginOrigin: `http://${loginHost}`,
    scope: CLIENT_SCOPES.join(' '),
    redirectUri: `http://${consoleHost}/`,
    homeHosts: home ? [HOME_HOST] : [],
    log: (line) => log({ function: 'web', ...line }),
  });

  timers.push(setInterval(() => {
    for (const board of boards) board.heartbeat();
    // The stand-in keeps every call for tests to look at. Nobody looks here.
    fake.calls.length = 0;
  }, HEARTBEAT_MS));
  if (live) {
    timers.push(setInterval(() => {
      for (const board of boards) board.tick();
    }, LIVE_TICK_MS));
  }

  return {
    consoleUrl: `http://${consoleHost}/`,
    loginOrigin: `http://${loginHost}`,
    scenario,
    user,
    live,
    home,
    fake,
    boards,
    signIn,
    stop,

    /** Take the boards' buttons from the lines of a stream, such as the terminal. */
    takeButtons(input, print) {
      terminal = createInterface({ input });
      terminal.on('line', (line) => {
        const answer = pressButton(boards, line);
        if (answer !== null) print(answer);
      });
    },
  };
}

// The command line.

const USAGE = `Usage: node cloud/dev/preview.mjs [options]

  --scenario <name>   start in the state this scenario builds (default: empty)
  --viewer            sign in as a viewer instead of a release manager
  --live              let the boards act by themselves; type 1 or 2 to press a button
  --home              serve the public home page instead of the console
  --port <number>     port of the console (default ${DEFAULT_PORT}); sign-in uses the next one
  --host <address>    a loopback address (default ${DEFAULT_HOST}); any other is refused
  --repeated-cancel <how>
                      what the stand-in for AWS does when a deployment that was cancelled
                      without force is cancelled again with force while a board is at
                      work, which AWS does not document: refused (default), accepted
                      (the board is stopped) or ignored (accepted, and nothing changes)
  --verbose           print the log lines of the two functions
  --help              show this text

Scenarios:
${Object.entries(SCENARIOS).map(([name, { summary }]) => `  ${name.padEnd(20)}${summary}`).join('\n')}
`;

/** The options the preview was started with. Throws a UsageError for anything else. */
export function parseArguments(argv) {
  const options = {
    scenario: 'empty', viewer: false, live: false, home: false, verbose: false, help: false,
    host: DEFAULT_HOST, port: DEFAULT_PORT, repeatedCancel: REPEATED_CANCEL[0],
  };
  // "--port=8000" is "--port 8000".
  const words = argv.flatMap((word) => {
    const mark = /^--[a-z][a-z-]*=/.test(word) ? word.indexOf('=') : -1;
    return mark === -1 ? [word] : [word.slice(0, mark), word.slice(mark + 1)];
  });
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const value = () => {
      index += 1;
      if (index >= words.length) throw new UsageError(`${word} needs a value.`);
      return words[index];
    };
    if (word === '--scenario') {
      options.scenario = value();
    } else if (word === '--host') {
      options.host = value();
    } else if (word === '--repeated-cancel') {
      options.repeatedCancel = value();
    } else if (word === '--port') {
      const text = value();
      if (!/^\d{1,5}$/.test(text)) throw new UsageError('The port must be a number.');
      options.port = Number(text);
    } else if (word === '--viewer') {
      options.viewer = true;
    } else if (word === '--live') {
      options.live = true;
    } else if (word === '--home') {
      options.home = true;
    } else if (word === '--verbose') {
      options.verbose = true;
    } else if (word === '--help' || word === '-h') {
      options.help = true;
    } else {
      throw new UsageError(`Unknown option: ${word}`);
    }
  }
  return options;
}

function banner({ consoleUrl, loginOrigin, user, scenario, live, home }) {
  if (home) {
    return `
  Cranium home page: LOCAL PREVIEW

    Home page   ${consoleUrl}

  The page is served by the real web function, as the host name ${HOME_HOST}. Its
  links go to the real addresses of the console and the repository.

  Stop with Ctrl+C.
`;
  }
  const boards = live
    ? 'live: type 1 or 2 and Enter to press that button on a waiting board'
    : 'stay where the scenario left them (--live lets them act)';
  return `
  Cranium firmware console: LOCAL PREVIEW

  This is not the deployed console, and it is not connected to AWS. The API runs in
  this process against an in-memory stand-in, sign-in is emulated without a password,
  and the boards are simulated. Everything shown was built by the scenario or done in
  this session, and is gone when the preview stops.

    Console     ${consoleUrl}
    Sign-in     emulated at ${loginOrigin}
    Signed in   ${user.email} (${user.role})
    Scenario    ${scenario}
                ${SCENARIOS[scenario].summary}
    Boards      ${boards}
    Firmware    accepts the images in cloud/api/test/fixtures that are signed with
                test_signing_pub.pem, for example valid-1.2.3+5.signed.bin

  Stop with Ctrl+C.
`;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      return;
    }
    const print = (text) => console.log(`  ${text}`);
    const preview = await createPreview({
      ...options,
      log: (line) => {
        if (options.verbose || line.level === 'error') console.log(JSON.stringify(line));
      },
      say: print,
    });
    console.log(banner(preview));
    if (options.live) preview.takeButtons(process.stdin, print);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => preview.stop().then(() => process.exit(0)));
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  }
}

// Started as a program, not imported. The path is compared resolved: Node gives the
// module its real location, also when it was started through a symbolic link.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
