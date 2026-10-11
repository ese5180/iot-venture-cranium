/**
 * Tests for the local preview, and through it for the one place where the web console
 * and the API meet.
 *
 * The preview serves the real page and the real API handler. The tests sign in with
 * the console's own code (web/src/site/assets/core.js), read every answer of the API
 * with the console's own client, and compare what the client made of an answer with
 * what the API sent. A field that one side renames or drops shows up here.
 *
 * Run with `node --test` in cloud/dev. No network beyond the loopback address, no AWS.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { SCENARIOS, UsageError, createPreview, parseArguments } from './preview.mjs';

// The console's script, loaded as the browser loads it (web/test/core.test.mjs says
// why it goes through a data: address).
const source = readFileSync(new URL('../web/src/site/assets/core.js', import.meta.url));
const core = await import(`data:text/javascript;base64,${source.toString('base64')}`);

const FIXTURES = new URL('../api/test/fixtures/', import.meta.url);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const fixture = (file) => readFileSync(new URL(file, FIXTURES));
const pick = (object, ...names) => Object.fromEntries(names.map((name) => [name, object[name]]));

/**
 * A preview on two free ports. Its clock stands still unless the test moves it, apart
 * from one millisecond for every look at it, so that no two things happen at once.
 */
async function start(t, options = {}) {
  const clock = { ms: Date.UTC(2026, 9, 10, 22, 15, 0) };
  const now = () => {
    clock.ms += 1;
    return clock.ms;
  };
  const preview = await createPreview({ port: 0, now, ...options });
  t.after(() => preview.stop());
  return { preview, clock, origin: preview.consoleUrl.slice(0, -1) };
}

/** The sign-in settings in the page, read the way the console reads them. */
async function settings(origin) {
  const page = await (await fetch(`${origin}/`)).text();
  const content = /<meta name="cranium-config" content="([^"]*)">/.exec(page)[1];
  return core.readConfig(content.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
}

/** A request for an authorization code as the console builds it, with changes. */
function authorization(config, changes = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const fields = {
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state: randomBytes(32).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...changes,
  };
  for (const [name, value] of Object.entries(fields)) if (value === undefined) delete fields[name];
  return { verifier, fields, url: `${config.loginOrigin}/oauth2/authorize?${new URLSearchParams(fields)}` };
}

function redeem(config, code, verifier, changes = {}) {
  return fetch(`${config.loginOrigin}/oauth2/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
      ...changes,
    }),
  });
}

/** Sign in by hand, as a browser would: authorize, follow the redirect, redeem the code. */
async function accessToken(origin) {
  const config = await settings(origin);
  const { verifier, url } = authorization(config);
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  return (await (await redeem(config, back.searchParams.get('code'), verifier)).json()).access_token;
}

/** One request to the API with a token, as { status, headers, body }. */
async function call(origin, token, method, path, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** The body of an upload of a fixture image. */
function image(file, fields = {}) {
  return { filename: 'zephyr.signed.bin', data: fixture(file).toString('base64'), ...fields };
}

/** The pieces of a browser tab that the console's sign-in code uses. */
function browserTab(hash) {
  const stored = new Map();
  const location = {
    search: '',
    hash,
    pathname: '/',
    assigned: null,
    assign(url) {
      location.assigned = url;
    },
  };
  return {
    stored,
    location,
    storage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
      clear: () => stored.clear(),
    },
    history: {
      replaceState(_state, _title, address) {
        location.search = '';
        location.replaced = address;
      },
    },
  };
}

/** The little of XMLHttpRequest that the console's upload uses, carried out with fetch. */
function requestTo(origin) {
  return class {
    constructor() {
      this.headers = {};
      this.upload = {};
    }

    open(method, path) {
      this.method = method;
      this.path = path;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    getResponseHeader(name) {
      return this.answer.headers.get(name);
    }

    send(body) {
      const { method, headers } = this;
      fetch(`${origin}${this.path}`, { method, headers, body }).then(async (answer) => {
        this.answer = answer;
        this.status = answer.status;
        this.responseText = await answer.text();
        this.upload.onload();
        this.onload();
      }, () => this.onerror());
    }
  };
}

/**
 * Sign in with the console's own code and return its API client. `sent` receives the
 * body of every answer as the API sent it.
 */
async function consoleClient(origin, clock, sent) {
  const config = await settings(origin);
  const tab = browserTab('#/devices');
  const auth = core.createAuth({
    config,
    storage: tab.storage,
    location: tab.location,
    history: tab.history,
    fetch,
    crypto: webcrypto,
    now: () => clock.ms,
  });

  assert.deepEqual(await auth.resume('#/devices'), { status: 'redirecting' });
  const reply = await fetch(tab.location.assigned, { redirect: 'manual' });
  assert.equal(reply.status, 302);
  tab.location.search = new URL(reply.headers.get('location')).search;
  assert.deepEqual(await auth.resume('#/overview'), { status: 'signed-in', route: '#/devices' });

  const api = core.createApi({
    auth,
    crypto: webcrypto,
    clock: core.createClock(() => clock.ms),
    XMLHttpRequest: requestTo(origin),
    onUnauthorized: () => assert.fail('the API refused the token of the console'),
    async fetch(path, init) {
      const response = await fetch(`${origin}${path}`, init);
      sent.push(await response.clone().json());
      return response;
    },
  });
  return { api, auth, tab, config };
}

/** The error that a call of the console's client ends with. */
function failure(promise) {
  return promise.then(() => assert.fail('the call went through'), (error) => error);
}

test('the command line: defaults, both spellings of an option, nothing unknown', () => {
  assert.deepEqual(parseArguments([]), {
    scenario: 'empty', viewer: false, live: false, verbose: false, help: false, host: '127.0.0.1', port: 8787,
    repeatedCancel: 'refused',
  });
  assert.equal(parseArguments(['--scenario', 'revoked']).scenario, 'revoked');
  const options = parseArguments(['--scenario=downloading', '--viewer', '--live', '--port=9000']);
  assert.deepEqual(pick(options, 'scenario', 'viewer', 'live', 'port'),
    { scenario: 'downloading', viewer: true, live: true, port: 9000 });
  assert.equal(parseArguments(['-h']).help, true);
  assert.equal(parseArguments(['--repeated-cancel', 'accepted']).repeatedCancel, 'accepted');
  assert.equal(parseArguments(['--repeated-cancel=ignored']).repeatedCancel, 'ignored');

  for (const argv of [['--bind', '0.0.0.0'], ['--port'], ['--port', 'http'], ['--scenario'], ['revoked'],
    ['--repeated-cancel']]) {
    assert.throws(() => parseArguments(argv), UsageError, argv.join(' '));
  }
});

test('the preview refuses to listen anywhere but on a loopback address', async (t) => {
  const elsewhere = ['0.0.0.0', '192.168.1.20', '10.0.0.1', '::', '::1', 'localhost', '', '127.0.0.1.example'];
  for (const host of elsewhere) {
    await assert.rejects(createPreview({ host, port: 0 }), UsageError, host);
  }
  await assert.rejects(createPreview({ scenario: 'no-such-scenario', port: 0 }), UsageError);
  await assert.rejects(createPreview({ port: 70000 }), UsageError);

  const { preview } = await start(t);
  assert.equal(new URL(preview.consoleUrl).hostname, '127.0.0.1');
  assert.equal(new URL(preview.loginOrigin).hostname, '127.0.0.1');
});

test('a request that is not addressed to the preview itself is turned away', async (t) => {
  const { preview } = await start(t);
  // What a page elsewhere sends once it has pointed a host name of its own at 127.0.0.1.
  const status = (address, path) => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(address);
    httpRequest({ host: hostname, port, path, headers: { host: 'console.example' } },
      (response) => resolve(response.statusCode)).on('error', reject).end();
  });
  assert.equal(await status(preview.consoleUrl, '/'), 403);
  assert.equal(await status(preview.consoleUrl, '/api/me'), 403);
  assert.equal(await status(preview.loginOrigin, '/oauth2/authorize'), 403);
});

test('the gateway has the three routes of the HTTP API and nothing else', async (t) => {
  const { origin } = await start(t);
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  assert.equal(assets.length, 4);
  for (const asset of assets) assert.equal((await fetch(`${origin}${asset}`)).status, 200, asset);

  // No route: API Gateway answers these itself. The deployed gateway was asked the same.
  const routeless = [['POST', '/'], ['GET', '/assets'], ['GET', '/api'], ['GET', '/index.html'],
    ['GET', '/favicon.ico'], ['GET', '/oauth2/authorize'], ['DELETE', '/assets/app.css']];
  for (const [method, path] of routeless) {
    const answer = await fetch(`${origin}${path}`, { method });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.deepEqual(await answer.json(), { message: 'Not Found' });
  }
  assert.equal((await fetch(`${origin}/`, { method: 'HEAD' })).status, 404);

  // A route of the web function with a path it does not know: the function answers.
  for (const path of ['/assets/000000000000/app.css', '/assets/']) {
    const unknown = await fetch(`${origin}${path}`);
    assert.equal(unknown.status, 404, path);
    assert.equal(await unknown.text(), 'Not found\n');
  }
  // A route of the API: the authorizer comes first, then the function says what it has not.
  assert.equal((await fetch(`${origin}/api/`)).status, 401);
  const missing = await call(origin, await accessToken(origin), 'GET', '/api/');
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'not_found']);
});

test('the API is behind the authorizer: no token, no answer', async (t) => {
  const { origin, clock } = await start(t);
  const answerTo = (authorization) => fetch(`${origin}/api/me`, { headers: { authorization } });

  for (const headers of [{}, { authorization: 'Bearer made-up' }, { authorization: '' }]) {
    const answer = await fetch(`${origin}/api/me`, { headers });
    assert.equal(answer.status, 401);
    assert.deepEqual(await answer.json(), { message: 'Unauthorized' });
  }

  const token = await accessToken(origin);
  assert.equal((await answerTo(`Bearer ${token}`)).status, 200);
  // API Gateway takes the token with or without the word Bearer.
  assert.equal((await answerTo(token)).status, 200);

  // The token is good for an hour, like the one Cognito issues.
  clock.ms += 3590_000;
  assert.equal((await answerTo(`Bearer ${token}`)).status, 200);
  clock.ms += 10_000;
  assert.equal((await answerTo(`Bearer ${token}`)).status, 401);
});

test('sign-in refuses what Cognito refuses, and insists on state and PKCE', async (t) => {
  const { origin } = await start(t);
  const config = await settings(origin);
  const ask = (changes) => fetch(authorization(config, changes).url, { redirect: 'manual' });

  // An unknown client or return address is never redirected to.
  const strangers = [{ client_id: 'another-client' }, { redirect_uri: 'http://127.0.0.1:9/' },
    { redirect_uri: config.redirectUri.slice(0, -1) }, { redirect_uri: `${config.redirectUri}callback` }];
  for (const changes of strangers) {
    const answer = await ask(changes);
    assert.equal(answer.status, 400, JSON.stringify(changes));
    assert.equal(answer.headers.get('location'), null);
  }

  // Anything else goes back to the console with an error, and without a code.
  const refusals = [
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ scope: 'openid aws.cognito.signin.user.admin' }, 'invalid_scope'],
    [{ scope: undefined }, 'invalid_scope'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ state: undefined }, 'invalid_request'],
  ];
  for (const [changes, error] of refusals) {
    const answer = await ask(changes);
    assert.equal(answer.status, 302, JSON.stringify(changes));
    const back = new URL(answer.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, config.redirectUri);
    assert.equal(back.searchParams.get('error'), error, JSON.stringify(changes));
    assert.equal(back.searchParams.get('code'), null);
  }

  /** A fresh code, and the verifier that goes with it. */
  async function grant() {
    const { verifier, fields, url } = authorization(config);
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
    assert.equal(back.searchParams.get('state'), fields.state);
    return { verifier, code: back.searchParams.get('code') };
  }
  const refused = async (answer, error) => {
    assert.equal(answer.status, 400);
    assert.deepEqual(await answer.json(), { error });
  };

  let { code, verifier } = await grant();
  await refused(await redeem(config, code, randomBytes(32).toString('base64url')), 'invalid_grant');
  // The failed attempt used the code up.
  await refused(await redeem(config, code, verifier), 'invalid_grant');

  ({ code, verifier } = await grant());
  await refused(await redeem(config, code, verifier, { redirect_uri: 'http://127.0.0.1:9/' }), 'invalid_grant');
  ({ code, verifier } = await grant());
  await refused(await redeem(config, code, verifier, { client_id: 'another-client' }), 'invalid_client');
  ({ code, verifier } = await grant());
  await refused(await redeem(config, code, verifier, { grant_type: 'refresh_token' }),
    'unsupported_grant_type');

  ({ code, verifier } = await grant());
  const answer = await redeem(config, code, verifier);
  assert.equal(answer.status, 200);
  // The page runs on another origin and has to be allowed to read this.
  assert.equal(answer.headers.get('access-control-allow-origin'), origin);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  const tokens = await answer.json();
  assert.deepEqual(Object.keys(tokens).sort(),
    ['access_token', 'expires_in', 'id_token', 'refresh_token', 'token_type']);
  assert.deepEqual([tokens.token_type, tokens.expires_in], ['Bearer', 3600]);
  await refused(await redeem(config, code, verifier), 'invalid_grant');

  // Sign-out comes back to the console, and only to the console.
  const signOut = (uri) => fetch(
    `${config.loginOrigin}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: uri })}`,
    { redirect: 'manual' });
  assert.equal((await signOut(config.redirectUri)).headers.get('location'), config.redirectUri);
  assert.equal((await signOut('http://127.0.0.1:9/')).status, 400);
});

test('the console signs in with its own code and leaves no refresh token behind', async (t) => {
  const { preview, origin, clock } = await start(t);
  const { api, auth, tab, config } = await consoleClient(origin, clock, []);

  assert.equal(tab.location.assigned.startsWith(`${config.loginOrigin}/oauth2/authorize?`), true);
  // The code is out of the address bar, and the tab keeps the access token and nothing else.
  assert.equal(tab.location.replaced, '/#/devices');
  assert.deepEqual([...tab.stored.keys()], ['cranium.session']);
  const session = JSON.parse(tab.stored.get('cranium.session'));
  assert.deepEqual(Object.keys(session).sort(), ['accessToken', 'expiresAt']);
  assert.equal(await auth.revocation(), 'revoked');
  assert.equal(preview.signIn.refreshTokensLeft(), 0);

  assert.deepEqual(await api.me(), {
    sub: preview.user.sub, email: preview.user.email, groups: ['release-managers'], canWrite: true,
  });
  // The page may talk to the sign-in origin, and to no other.
  const policy = (await fetch(`${origin}/`)).headers.get('content-security-policy');
  assert.equal(policy.includes(`connect-src 'self' ${config.loginOrigin};`), true);
});

for (const scenario of Object.keys(SCENARIOS)) {
  test(`${scenario}: the console's client reads every answer of the API as it was sent`, async (t) => {
    const { origin, clock } = await start(t, { scenario });
    const sent = [];
    const { api } = await consoleClient(origin, clock, sent);

    const me = await api.me();
    assert.deepEqual({ ...me, expiresAt: sent.at(-1).expiresAt }, sent.at(-1));

    const fleet = await api.devices();
    assert.deepEqual(fleet, sent.at(-1));
    for (const device of fleet.devices) {
      assert.deepEqual(await api.device(device.thing), sent.at(-1));
    }

    const firmware = await api.firmware();
    assert.deepEqual(firmware, {
      releases: sent.at(-1).releases,
      fingerprint: sent.at(-1).signingKey.fingerprint,
      slotSize: sent.at(-1).slotSize,
    });

    const deployments = await api.deployments();
    assert.deepEqual(deployments, sent.at(-1).deployments);
    for (const { id } of deployments) {
      const deployment = await api.deployment(id);
      assert.deepEqual(deployment, sent.at(-1).deployment);
      // The console has words for every state the API names.
      for (const execution of deployment.executions) {
        assert.notEqual(core.describeExecution(execution).title, 'Unknown state', execution.phase);
        assert.notEqual(core.describeStatus(execution.status).label, 'Unknown', execution.status);
      }
      assert.notEqual(core.describeDeployment(deployment).label, 'Unknown', deployment.status);
    }

    const audit = await api.audit({ limit: 50 });
    assert.equal(audit.next, sent.at(-1).next);
    assert.deepEqual(audit.entries.map((entry) => ({ ...entry, detail: Object.fromEntries(entry.detail) })),
      sent.at(-1).entries);
    for (const entry of audit.entries) assert.notEqual(core.describeAudit(entry).verb, 'did something');
  });
}

test('the console\'s client makes every change the way the API expects it', async (t) => {
  const { preview, origin, clock } = await start(t, { scenario: 'one-board-idle' });
  const sent = [];
  const { api } = await consoleClient(origin, clock, sent);
  const [board] = preview.boards;
  const { thing } = board;
  const outcomes = (entries) => entries.map((entry) => `${entry.action} ${entry.outcome}`);

  // An upload, prepared as the Firmware page prepares it. What the page reads from the
  // file before sending is what the server reads from it afterwards.
  const file = 'valid-padded-signature.signed.bin';
  const bytes = new Uint8Array(fixture(file));
  const header = core.readImageHeader(bytes);
  const stages = [];
  const release = await api.upload({
    filename: core.recordedFilename(file),
    notes: core.singleLine('  New pad layout.\n'),
    data: core.toBase64(bytes),
  }, (step) => stages.push(step.stage));
  assert.deepEqual(pick(release, 'version', 'sha256', 'size', 'headerSize', 'payloadSize'), {
    version: header.version,
    sha256: await core.sha256Hex(bytes),
    size: bytes.length,
    headerSize: header.headerSize,
    payloadSize: header.payloadSize,
  });
  assert.deepEqual(pick(release, 'version', 'filename', 'notes', 'status'),
    { version: '2.0.0+0', filename: file, notes: 'New pad layout.', status: 'active' });
  assert.deepEqual([stages[0], stages.at(-1)], ['sending', 'checking']);
  const firmware = await api.firmware();
  assert.deepEqual(firmware.releases[0], release);
  // Chosen again, the page says that this file is registered already.
  const review = core.reviewImage({ header, size: bytes.length, digest: release.sha256 }, firmware);
  assert.deepEqual(review.notes.map((note) => note.tone), ['good', 'warn']);

  const other = core.toBase64(new Uint8Array(fixture('signed-with-other-key.signed.bin')));
  const refused = await failure(api.upload({ filename: 'zephyr.signed.bin', notes: '', data: other }));
  assert.deepEqual(pick(refused, 'name', 'status', 'code'),
    { name: 'ApiError', status: 422, code: 'wrong_key' });
  assert.match(refused.message, /signed with a different key/);
  assert.equal(typeof refused.requestId, 'string');

  // A deployment, and the refusal that names what is in the way. The note is pasted
  // text with a line separator and characters that cannot be seen: cleaned up the way
  // the page cleans it up, the API takes it.
  const note = core.singleLine('Bench\u200b board\u2028first.\u200f');
  const deployment = await api.deploy({ version: '2.0.0+0', things: [thing], note });
  assert.deepEqual(deployment, sent.at(-1).deployment);
  assert.deepEqual(pick(deployment, 'version', 'status', 'note', 'things'),
    { version: '2.0.0+0', status: 'IN_PROGRESS', note: 'Bench board first.', things: [thing] });
  assert.equal(deployment.createdBy.email, preview.user.email);
  assert.deepEqual(deployment.executions.map((execution) => execution.phase), ['waiting_for_device']);

  const busy = await failure(api.deploy({ version: '1.2.3+5', things: [thing], note: '' }));
  assert.deepEqual(pick(busy, 'status', 'code'), { status: 409, code: 'device_busy' });
  assert.deepEqual(core.busyBoards(busy), [{ thing, deployment: deployment.id }]);

  // The board starts. A cancellation without force leaves it alone, and asking for the
  // same again is told what is left.
  board.lookForJob();
  board.pressButton1();
  board.download(20);
  const withdrawn = await api.cancel(deployment.id, false);
  assert.deepEqual(withdrawn, sent.at(-1).deployment);
  assert.equal(withdrawn.status, 'CANCELED');
  assert.deepEqual(pick(withdrawn.executions[0], 'status', 'phase'),
    { status: 'IN_PROGRESS', phase: 'downloading' });
  const repeated = await failure(api.cancel(deployment.id, false));
  assert.deepEqual(pick(repeated, 'status', 'code'), { status: 409, code: 'already_cancelled' });
  assert.match(repeated.message, /1 board is still at work/);

  // What a forced cancellation does to a deployment that is cancelled already, AWS
  // does not document. The stand-in refuses it, and the client hands the refusal on.
  const unstopped = await failure(api.cancel(deployment.id, true));
  assert.deepEqual(pick(unstopped, 'status', 'code'), { status: 409, code: 'cancel_refused' });
  assert.match(unstopped.message, /AWS did not accept the cancellation/);

  // Revoking the release while that board is at work marks the release and blocks its
  // image, but it is not complete, and the record says so to everyone who reads it.
  const incomplete = await failure(api.revoke('2.0.0+0', core.singleLine('Pads stop responding. ')));
  assert.deepEqual(pick(incomplete, 'status', 'code'), { status: 500, code: 'revoke_incomplete' });
  assert.equal(incomplete.message.includes(deployment.id), true);
  const marked = (await api.firmware()).releases[0];
  assert.deepEqual(marked, sent.at(-1).releases[0]);
  assert.deepEqual(pick(marked, 'version', 'status'), { version: '2.0.0+0', status: 'revoked' });
  assert.deepEqual(pick(marked.revoked, 'reason', 'enforcedAt'), { reason: 'Pads stop responding.', enforcedAt: null });

  // The bucket refuses the image now, so the board's download fails. With no board
  // left at work, revoking again completes the revocation and records when.
  board.download(60);
  const ended = await api.deployment(deployment.id);
  assert.deepEqual(pick(ended.executions[0], 'status', 'phase', 'reason'),
    { status: 'FAILED', phase: 'failed', reason: 'download_failed' });
  const revocation = await api.revoke('2.0.0+0', 'Finish it.');
  assert.deepEqual(revocation, sent.at(-1));
  assert.equal(revocation.release.status, 'revoked');
  assert.equal(revocation.release.revoked.reason, 'Pads stop responding.');
  assert.equal(revocation.release.revoked.at, marked.revoked.at);
  assert.equal(typeof revocation.release.revoked.enforcedAt, 'string');
  assert.deepEqual(revocation.cancelled, []);
  assert.deepEqual((await api.firmware()).releases[0], revocation.release);
  const again = await failure(api.revoke('2.0.0+0', 'Once more.'));
  assert.deepEqual(pick(again, 'status', 'code'), { status: 409, code: 'already_revoked' });
  const closed = await failure(api.deploy({ version: '2.0.0+0', things: [thing], note: '' }));
  assert.deepEqual(pick(closed, 'status', 'code'), { status: 409, code: 'release_revoked' });
  const unknown = await failure(api.deploy({ version: '9.9.9+9', things: [thing], note: '' }));
  assert.deepEqual(pick(unknown, 'status', 'code'), { status: 404, code: 'unknown_version' });

  // A deployment that is in progress is stopped with force in one step: that is what
  // AWS documents.
  const second = await api.deploy({ version: '1.2.3+5', things: [thing], note: '' });
  board.lookForJob();
  board.pressButton1();
  const stopped = await api.cancel(second.id, true);
  assert.deepEqual(stopped, sent.at(-1).deployment);
  assert.deepEqual(pick(stopped.executions[0], 'status', 'phase'), { status: 'CANCELED', phase: 'cancelled' });
  const finished = await failure(api.cancel(second.id, true));
  assert.deepEqual(pick(finished, 'status', 'code'), { status: 409, code: 'already_finished' });

  // Each of these left its entry, newest first, a page at a time.
  const audit = await api.audit({ limit: 8 });
  assert.deepEqual(outcomes(audit.entries), [
    'deployment.cancel rejected', 'deployment.cancel ok', 'deployment.create ok',
    'deployment.create rejected', 'deployment.create rejected', 'firmware.revoke rejected',
    'firmware.revoke ok', 'firmware.revoke error',
  ]);
  const older = await api.audit({ limit: 50, before: audit.next });
  assert.deepEqual(outcomes(older.entries), [
    'deployment.cancel rejected', 'deployment.cancel rejected', 'deployment.cancel ok',
    'deployment.create rejected', 'deployment.create ok',
    'firmware.upload rejected', 'firmware.upload ok', 'firmware.upload ok', 'firmware.upload ok',
  ]);
  assert.equal(older.next, null);
});

test('the stand-in can be told what a second, forced cancellation does', async (t) => {
  /** One board at work on a deployment that was cancelled without force. */
  async function atWork(repeatedCancel) {
    const { preview, origin } = await start(t, { scenario: 'one-board-idle', repeatedCancel });
    const token = await accessToken(origin);
    const [board] = preview.boards;
    const created = await call(origin, token, 'POST', '/api/deployments', { version: '1.2.3+5', things: [board.thing] });
    const { id } = created.body.deployment;
    board.lookForJob();
    board.pressButton1();
    assert.equal((await call(origin, token, 'POST', `/api/deployments/${id}/cancel`, { force: false })).status, 200);
    const forced = await call(origin, token, 'POST', `/api/deployments/${id}/cancel`, { force: true });
    return { forced, status: preview.fake.execution(id, board.thing).get().status };
  }

  let { forced, status } = await atWork('refused');
  assert.deepEqual([forced.status, forced.body.error.code, status], [409, 'cancel_refused', 'IN_PROGRESS']);
  ({ forced, status } = await atWork('accepted'));
  assert.deepEqual([forced.status, forced.body.deployment.executions[0].status, status], [200, 'CANCELED', 'CANCELED']);
  ({ forced, status } = await atWork('ignored'));
  assert.deepEqual([forced.status, forced.body.deployment.executions[0].status, status], [200, 'IN_PROGRESS', 'IN_PROGRESS']);

  await assert.rejects(createPreview({ port: 0, repeatedCancel: 'sometimes' }), UsageError);
});

test('each scenario is in the state its name promises', async (t) => {
  /** The scenario as the API describes it. */
  async function look(scenario) {
    const { preview, origin } = await start(t, { scenario });
    const token = await accessToken(origin);
    const get = async (path) => (await call(origin, token, 'GET', path)).body;
    const { deployments } = await get('/api/deployments');
    const details = [];
    for (const { id } of deployments) details.push((await get(`/api/deployments/${id}`)).deployment);
    const { releases } = await get('/api/firmware');
    return {
      preview,
      deployments,
      details,
      devices: (await get('/api/devices')).devices,
      releases: releases.map((release) => `${release.version} ${release.status}`),
      audit: (await get('/api/audit')).entries,
    };
  }

  let state = await look('empty');
  assert.deepEqual([state.devices, state.releases, state.deployments, state.audit], [[], [], [], []]);

  state = await look('one-board-idle');
  assert.deepEqual(state.releases, ['1.2.3+5 active', '1.2.3+4 active']);
  assert.equal(state.deployments.length, 0);
  assert.equal(state.devices.length, 1);
  assert.deepEqual(pick(state.devices[0], 'online', 'fw', 'ota', 'rssi'), {
    online: true,
    fw: { version: '1.2.3+4', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -52,
  });
  assert.equal(state.devices[0].uptime >= 3 * 3600, true);

  state = await look('waiting-for-button');
  assert.equal(state.deployments[0].status, 'IN_PROGRESS');
  assert.deepEqual(pick(state.details[0].executions[0], 'status', 'phase', 'progress', 'online'),
    { status: 'QUEUED', phase: 'waiting_for_button', progress: null, online: true });
  assert.deepEqual(pick(state.devices[0].ota, 'state', 'job'),
    { state: 'awaiting_user', job: state.deployments[0].id });

  state = await look('downloading');
  assert.deepEqual(pick(state.details[0].executions[0], 'status', 'phase', 'progress', 'running'),
    { status: 'IN_PROGRESS', phase: 'downloading', progress: 40, running: '1.2.3+4' });
  assert.equal(state.details[0].executions[0].secondsLeft > 29 * 60, true);

  state = await look('rolled-back');
  assert.equal(state.deployments[0].status, 'COMPLETED');
  assert.deepEqual(pick(state.details[0].executions[0], 'status', 'phase', 'reason', 'running'),
    { status: 'FAILED', phase: 'rolled_back', reason: 'rolled_back', running: '1.2.3+4' });
  assert.deepEqual(pick(state.devices[0], 'online', 'fw', 'ota'), {
    online: true,
    fw: { version: '1.2.3+4', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'rolled_back', error: 'not confirmed' },
  });

  state = await look('succeeded');
  assert.equal(state.deployments[0].status, 'COMPLETED');
  assert.deepEqual(pick(state.details[0].executions[0], 'status', 'phase', 'running'),
    { status: 'SUCCEEDED', phase: 'succeeded', running: '1.2.3+5' });
  assert.deepEqual(state.devices[0].fw, { version: '1.2.3+5', confirmed: true });
  assert.equal(state.devices[0].ota.last, 'succeeded');
  assert.deepEqual(state.audit.map((entry) => `${entry.action} ${entry.outcome}`),
    ['deployment.create ok', 'firmware.upload ok', 'firmware.upload ok']);

  state = await look('revoked');
  assert.deepEqual(state.releases, ['2.0.0+0 revoked', '1.2.3+5 active', '1.2.3+4 active']);
  assert.deepEqual(state.deployments.map((deployment) => `${deployment.version} ${deployment.status}`),
    ['2.0.0+0 CANCELED', '1.2.3+5 COMPLETED']);
  assert.deepEqual(pick(state.deployments[0].counts, 'canceled', 'queued', 'inProgress'),
    { canceled: 2, queued: 0, inProgress: 0 });
  const phases = (detail) => detail.executions.map((execution) => execution.phase).sort();
  assert.deepEqual(phases(state.details[0]), ['cancelled', 'cancelled']);
  assert.deepEqual(phases(state.details[1]), ['declined', 'succeeded']);
  // One board online, one switched off half an hour ago, one that never reported.
  const [first, second, third] = state.preview.boards.map(
    (board) => state.devices.find((device) => device.thing === board.thing));
  assert.deepEqual([first.online, second.online, third.online], [true, false, false]);
  assert.deepEqual([first.fw.version, second.fw.version, third.fw], ['1.2.3+5', '1.2.3+4', null]);
  assert.deepEqual([first.ota.last, second.ota.last, third.lastSeen], ['cancelled', 'cancelled', null]);
  assert.equal(state.audit.length, 7);
  assert.deepEqual(pick(state.audit[0], 'action', 'target', 'outcome'),
    { action: 'firmware.revoke', target: '2.0.0+0', outcome: 'ok' });
  const refusals = state.audit.filter((entry) => entry.outcome !== 'ok');
  assert.deepEqual(refusals.map((entry) => entry.detail.code), ['wrong_key']);
  // The revoked image can no longer be downloaded: its object carries the tag.
  const tagged = [...state.preview.fake.objects.values()].filter((object) => object.tags.revoked === 'true');
  assert.equal(tagged.length, 1);
});

test('an upload goes through the gateway to the real handler and is stored or refused', async (t) => {
  const { preview, origin } = await start(t);
  const token = await accessToken(origin);
  const upload = (file, fields) => call(origin, token, 'POST', '/api/firmware', image(file, fields));

  const accepted = await upload('valid-1.2.3+5.signed.bin', { notes: 'Second build.' });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.release.version, '1.2.3+5');
  assert.equal(accepted.body.release.uploadedBy.email, preview.user.email);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');

  const refusals = [
    ['signed-with-other-key.signed.bin', 422, 'wrong_key'],
    ['hash-only-unsigned.bin', 422, 'unsigned'],
    ['padded-and-confirmed.signed.bin', 422, 'trailing_data'],
    ['other-load-address.signed.bin', 422, 'wrong_target'],
    ['valid-1.2.3+5.signed.bin', 409, 'version_exists'],
    ['valid-1.2.3+4.signed.bin', 422, 'version_not_newer'],
  ];
  for (const [file, status, code] of refusals) {
    const refused = await upload(file);
    assert.deepEqual([refused.status, refused.body.error.code], [status, code], file);
    assert.equal(typeof refused.body.error.message, 'string');
  }

  // A version in a path keeps its plus sign, written out or encoded.
  for (const path of ['/api/firmware/1.2.3+5', '/api/firmware/1.2.3%2B5']) {
    const found = await call(origin, token, 'GET', path);
    assert.equal(found.body.release.sha256, accepted.body.release.sha256, path);
  }
  assert.equal(preview.fake.objects.size, 1);
  assert.equal((await call(origin, token, 'GET', '/api/audit')).body.entries.length, 7);
});

test('a viewer sees everything and changes nothing', async (t) => {
  const { preview, origin } = await start(t, { scenario: 'waiting-for-button', viewer: true });
  const token = await accessToken(origin);
  const me = await call(origin, token, 'GET', '/api/me');
  assert.deepEqual(pick(me.body, 'email', 'groups', 'canWrite'),
    { email: preview.user.email, groups: ['viewers'], canWrite: false });

  const { deployments } = (await call(origin, token, 'GET', '/api/deployments')).body;
  assert.equal(deployments.length, 1);
  const attempts = [
    ['/api/firmware', image('valid-padded-signature.signed.bin')],
    ['/api/firmware/1.2.3+5/revoke', { reason: 'No reason.' }],
    ['/api/deployments', { version: '1.2.3+5', things: deployments[0].things }],
    [`/api/deployments/${deployments[0].id}/cancel`, { force: true }],
  ];
  for (const [path, body] of attempts) {
    const refused = await call(origin, token, 'POST', path, body);
    assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required'], path);
  }
  const after = (await call(origin, token, 'GET', '/api/deployments')).body.deployments;
  assert.equal(after[0].status, 'IN_PROGRESS');
});

/** A preview with one idle board, a signed-in release manager and the terminal as a stream. */
async function bench(t) {
  const { preview, origin, clock } = await start(t, { scenario: 'one-board-idle' });
  const token = await accessToken(origin);
  const terminal = new PassThrough();
  const printed = [];
  preview.takeButtons(terminal, (text) => printed.push(text));
  const [board] = preview.boards;
  /** Read after the API's short caches have run out. */
  const read = (path) => {
    clock.ms += 6000;
    return call(origin, token, 'GET', path);
  };

  return {
    board,
    printed,
    /** Start a deployment of a version to the board; its id. */
    async deploy(version) {
      const created = await call(origin, token, 'POST', '/api/deployments', { version, things: [board.thing] });
      assert.equal(created.status, 201);
      return created.body.deployment.id;
    },
    cancel: (id, force) => call(origin, token, 'POST', `/api/deployments/${id}/cancel`, { force }),
    /** Type a line in the terminal. */
    async type(line) {
      terminal.write(`${line}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Let the board live for this many seconds. */
    seconds(count) {
      for (let second = 0; second < count; second += 1) board.tick();
    },
    /** The board's part in a deployment, as the API describes it. */
    execution: async (id) => (await read(`/api/deployments/${id}`)).body.deployment.executions[0],
    device: async () => (await read('/api/devices')).body.devices[0],
  };
}

test('a live board picks up an offer, waits for Button 1 and carries the update through', async (t) => {
  const { printed, deploy, type, seconds, execution, device } = await bench(t);
  const id = await deploy('1.2.3+5');
  assert.equal((await execution(id)).phase, 'waiting_for_device');

  await type('1');
  assert.deepEqual(printed, ['No board is waiting for a button. Start a deployment in the console first.']);

  seconds(1);
  assert.equal((await execution(id)).phase, 'waiting_for_button');
  await type('3');
  assert.match(printed.at(-1), /not a button/);

  await type('1');
  assert.equal((await execution(id)).phase, 'downloading');
  seconds(8);
  assert.deepEqual(pick(await execution(id), 'status', 'phase', 'progress'),
    { status: 'IN_PROGRESS', phase: 'downloading', progress: 40 });

  seconds(12);
  assert.deepEqual(pick(await execution(id), 'status', 'phase'), { status: 'IN_PROGRESS', phase: 'rebooting' });
  assert.equal((await device()).fw.version, '1.2.3+4');

  seconds(12);
  assert.deepEqual(pick(await execution(id), 'status', 'phase', 'running'),
    { status: 'SUCCEEDED', phase: 'succeeded', running: '1.2.3+5' });
  const after = await device();
  assert.deepEqual(after.fw, { version: '1.2.3+5', confirmed: true });
  assert.deepEqual(after.ota, { state: 'idle', job: null, progress: 0, last: 'succeeded', error: '' });
  assert.equal(after.uptime < 60, true);
  assert.equal(printed.length, 2);
});

test('a live board stops when its update is cancelled with force, and says so', async (t) => {
  const { deploy, cancel, type, seconds, execution, device } = await bench(t);
  const id = await deploy('1.2.3+5');
  seconds(1);
  await type('1');
  seconds(4);
  assert.equal((await device()).ota.progress, 20);

  const cancelled = await cancel(id, true);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.deployment.status, 'CANCELED');
  seconds(1);
  assert.equal((await execution(id)).phase, 'cancelled');
  assert.deepEqual(pick((await device()).ota, 'state', 'progress', 'last'),
    { state: 'idle', progress: 0, last: 'cancelled' });
  // Nothing was installed.
  seconds(60);
  assert.equal((await device()).fw.version, '1.2.3+4');
});

test('a live board declines with Button 2, and refuses a version that is not newer', async (t) => {
  const { deploy, type, seconds, execution, device } = await bench(t);
  let id = await deploy('1.2.3+5');
  seconds(1);
  await type('2');
  assert.deepEqual(pick(await execution(id), 'status', 'phase', 'reason', 'running'),
    { status: 'REJECTED', phase: 'declined', reason: 'declined', running: '1.2.3+4' });
  assert.equal((await device()).ota.last, 'declined');

  id = await deploy('1.2.3+4');
  seconds(1);
  assert.deepEqual(pick(await execution(id), 'status', 'phase', 'reason'),
    { status: 'REJECTED', phase: 'refused', reason: 'not_newer' });
  assert.deepEqual(pick((await device()).ota, 'state', 'last', 'error'),
    { state: 'idle', last: 'refused', error: 'not_newer' });
});
