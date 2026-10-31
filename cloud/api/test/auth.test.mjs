// Tests for authentication and authorization: reading the group claim the way API
// Gateway delivers it, refusing anything unexpected, and asking Cognito before a write.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authenticate, claimedSub, parseGroups } from '../src/auth.mjs';
import { HttpError } from '../src/http.mjs';
import { accessClaims, apiEvent, createTestConsole, fixture } from './fake-aws.mjs';

const CLIENT = 'localclient';
const SUB = '11111111-2222-4333-8444-555555555555';
const THING = 'cranium-fe5b26c0c5b1dcd7';

const eventWith = (claims) => apiEvent('GET', '/api/me', { claims });
const upload = () => ({
  filename: 'zephyr.signed.bin',
  data: fixture('valid-1.2.3+4.signed.bin').toString('base64'),
});

// The client id is passed on exactly as given, undefined included.
function refused(event, ...configured) {
  const clientId = configured.length === 0 ? CLIENT : configured[0];
  assert.throws(() => authenticate(event, clientId),
    (error) => error instanceof HttpError && error.status === 401 && error.code === 'unauthorized');
}

test('the group claim is read in the flattened form the gateway sends', () => {
  assert.deepEqual(parseGroups('[release-managers]'), ['release-managers']);
  assert.deepEqual(parseGroups('[viewers release-managers]'), ['viewers', 'release-managers']);
  assert.deepEqual(parseGroups('[not-release-managers]'), ['not-release-managers']);
  assert.deepEqual(parseGroups(undefined), []);
  assert.deepEqual(parseGroups('[]'), []);
  assert.deepEqual(parseGroups(''), []);
  // A real array is accepted as it is.
  assert.deepEqual(parseGroups(['viewers', 'release-managers']), ['viewers', 'release-managers']);
  assert.deepEqual(parseGroups(['viewers', 7, null, '']), ['viewers']);
  // One group without brackets, and any white space between names.
  assert.deepEqual(parseGroups('viewers'), ['viewers']);
  assert.deepEqual(parseGroups('[viewers\t release-managers]'), ['viewers', 'release-managers']);
});

test('group names are compared whole, never as parts of other text', () => {
  const has = (claim, name) => parseGroups(claim).includes(name);
  assert.equal(has('[not-release-managers]', 'release-managers'), false);
  assert.equal(has('[release-managers-emeritus]', 'release-managers'), false);
  assert.equal(has('[xrelease-managers viewersx]', 'release-managers'), false);
  assert.equal(has('[xrelease-managers viewersx]', 'viewers'), false);
  // Commas are legal in a group name and do not separate names.
  assert.equal(has('[other,release-managers]', 'release-managers'), false);
  // Only one bracket is stripped at each end.
  assert.equal(has('[[release-managers]]', 'release-managers'), false);
  assert.equal(has(' [release-managers] ', 'release-managers'), false);
  // Things that are not a claim at all.
  for (const claim of [null, 5, true, { 0: 'release-managers' }, new Set(['release-managers'])]) {
    assert.deepEqual(parseGroups(claim), []);
  }
});

test('a request without the expected claims is refused', () => {
  const good = accessClaims({ sub: SUB, groups: ['viewers'] });
  assert.equal(authenticate(eventWith(good), CLIENT).sub, SUB);

  refused(undefined);
  refused(null);
  refused({});
  refused({ requestContext: {} });
  refused({ requestContext: { authorizer: {} } });
  refused({ requestContext: { authorizer: { jwt: {} } } });
  refused({ requestContext: { authorizer: { jwt: { claims: null } } } });
  refused({ requestContext: { authorizer: { jwt: { claims: 'sub=x' } } } });
  refused({ requestContext: { authorizer: { jwt: { claims: [good] } } } });
  // Claims in the place payload format 1.0 would put them.
  refused({ requestContext: { authorizer: { claims: good } } });

  refused(eventWith({ ...good, token_use: 'id' }));
  refused(eventWith({ ...good, token_use: undefined }));
  refused(eventWith({ ...good, token_use: 'ACCESS' }));
  refused(eventWith({ ...good, token_use: ['access'] }));
  refused(eventWith({ ...good, client_id: 'anotherclient' }));
  refused(eventWith({ ...good, client_id: undefined }));
  refused(eventWith({ ...good, client_id: [CLIENT] }));
  // An ID token names the client in aud, not in client_id.
  refused(eventWith({ sub: SUB, token_use: 'id', aud: CLIENT, 'cognito:groups': '[release-managers]' }));

  for (const sub of [undefined, null, '', 7, ['x'], 'has space', 'new\nline', 'x'.repeat(129), '<script>']) {
    refused(eventWith({ ...good, sub }));
  }

  // A server that does not know its own client id accepts nobody.
  refused(eventWith(good), '');
  refused(eventWith(good), undefined);
  refused(eventWith({ ...good, client_id: undefined }), undefined);
});

test('the caller is described by sub, console groups and expiry', () => {
  const caller = authenticate(eventWith({
    ...accessClaims({ sub: SUB, groups: ['viewers', 'some-other-group', 'release-managers'], exp: 1787988914 }),
  }), CLIENT);
  assert.deepEqual(caller, { sub: SUB, groups: ['release-managers', 'viewers'], expiresAt: 1787988914 });

  const bare = authenticate(eventWith({ sub: SUB, token_use: 'access', client_id: CLIENT }), CLIENT);
  assert.deepEqual(bare, { sub: SUB, groups: [], expiresAt: null });
  for (const exp of ['', 'soon', null, true, [5], '12.5', '-3']) {
    const claims = { ...accessClaims({ sub: SUB }), exp };
    assert.equal(authenticate(eventWith(claims), CLIENT).expiresAt, null);
  }
  assert.equal(claimedSub(eventWith({ sub: SUB })), SUB);
  assert.equal(claimedSub(eventWith({ sub: 'not a sub' })), '');
  assert.equal(claimedSub({}), '');
});

test('every route answers 401 without valid claims and writes nothing', async () => {
  const { fake, call } = createTestConsole();
  const routes = [
    ['GET', '/api/me'], ['GET', '/api/devices'], ['GET', `/api/devices/${THING}`], ['GET', '/api/firmware'],
    ['GET', '/api/firmware/1.2.3+4'], ['GET', '/api/deployments'], ['GET', '/api/audit'],
    ['GET', '/api/no-such-route'], ['DELETE', '/api/firmware'],
  ];
  for (const [method, path] of routes) {
    for (const claims of [undefined, { sub: SUB, token_use: 'id', client_id: CLIENT }]) {
      const response = await call(method, path, { claims });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.body.error.code, 'unauthorized');
    }
  }
  assert.deepEqual(fake.methodsCalled(), []);
});

test('every route needs one of the console groups', async () => {
  const console_ = createTestConsole();
  const outsider = console_.addUser('outsider', []);
  const lookalike = console_.addUser('lookalike', ['not-release-managers']);
  const unlisted = console_.addUser('unlisted', [], { tokenGroups: null });
  const viewer = console_.addUser('viewer', ['viewers']);

  for (const user of [outsider, lookalike, unlisted]) {
    for (const path of ['/api/me', '/api/devices', '/api/firmware', '/api/deployments', '/api/audit', '/api/nothing']) {
      const response = await console_.call('GET', path, { as: user });
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'forbidden');
    }
  }
  assert.equal(lookalike.claims['cognito:groups'], '[not-release-managers]');
  assert.equal(Object.hasOwn(unlisted.claims, 'cognito:groups'), false);

  for (const path of ['/api/me', '/api/devices', '/api/firmware', '/api/deployments', '/api/audit']) {
    assert.equal((await console_.call('GET', path, { as: viewer })).status, 200, path);
  }
  // A member still gets 404 for an address that does not exist.
  const missing = await console_.call('GET', '/api/nothing', { as: viewer });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

test('GET /api/me reports the token\'s groups and the address from Cognito', async () => {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers', 'viewers']);
  const viewer = console_.addUser('viewer', ['viewers']);

  const first = await console_.call('GET', '/api/me', { as: manager });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    sub: manager.sub, email: manager.email, groups: ['release-managers', 'viewers'], canWrite: true,
    expiresAt: 4102444800,
  });
  const second = await console_.call('GET', '/api/me', { as: viewer });
  assert.deepEqual(second.body, {
    sub: viewer.sub, email: viewer.email, groups: ['viewers'], canWrite: false, expiresAt: 4102444800,
  });

  // The address comes with the live check on reads, once a minute for each user.
  const lookups = () => console_.fake.calls.filter((entry) => entry.method === 'getUser').length;
  assert.equal(lookups(), 2);
  console_.advance(59 * 1000);
  await console_.call('GET', '/api/me', { as: manager });
  assert.equal(lookups(), 2);
  console_.advance(2 * 1000);
  await console_.call('GET', '/api/me', { as: manager });
  assert.equal(lookups(), 3);

  // If Cognito cannot be asked, the answer still comes, without an address that is out
  // of date.
  console_.advance(6 * 60 * 1000);
  console_.fake.failNext('getUser');
  const degraded = await console_.call('GET', '/api/me', { as: manager });
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.email, '');
  assert.equal(degraded.body.canWrite, true);
});

test('a viewer cannot change anything', async () => {
  const console_ = createTestConsole();
  const viewer = console_.addUser('viewer', ['viewers']);
  const writes = [
    ['POST', '/api/firmware', upload()],
    ['POST', '/api/firmware/1.2.3+4/revoke', { reason: 'x' }],
    ['POST', '/api/deployments', { version: '1.2.3+4', things: [THING] }],
    ['POST', '/api/deployments/cranium-1-2-3-b4-20261010T221500Z-9f3a/cancel', { force: true }],
  ];
  for (const [method, path, body] of writes) {
    const response = await console_.call(method, path, { as: viewer, body });
    assert.equal(response.status, 403, path);
    assert.equal(response.body.error.code, 'release_manager_required');
    assert.equal(response.body.error.message, 'Only release managers can do this.');
  }
  // Cognito was asked who the viewer is, and the refusal was logged. Nothing else was
  // read or written on the viewer's behalf.
  const touched = new Set(console_.fake.methodsCalled());
  assert.deepEqual([...touched].sort(), ['getUser', 'listUserGroups', 'putAudit']);
  assert.equal(console_.fake.calls.filter((call) => call.method === 'getUser').length, writes.length);
  assert.equal(console_.fake.objects.size, 0);
});

test('a write asks Cognito at that moment, whatever the token says', async () => {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const attempt = () => console_.call('POST', '/api/firmware', { as: manager, body: upload() });

  // Removed from the group after the token was issued.
  console_.fake.user(manager.sub).setGroups(['viewers']);
  let response = await attempt();
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'release_manager_required');
  assert.equal(response.body.error.message, 'You are no longer a release manager.');

  // Disabled.
  console_.fake.user(manager.sub).setGroups(['release-managers']);
  console_.fake.user(manager.sub).disable();
  response = await attempt();
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'account_inactive');

  // Not confirmed: still on a temporary password, or flagged.
  console_.fake.user(manager.sub).enable();
  for (const status of ['FORCE_CHANGE_PASSWORD', 'UNCONFIRMED', 'RESET_REQUIRED', 'COMPROMISED', '']) {
    console_.fake.user(manager.sub).setStatus(status);
    response = await attempt();
    assert.equal(response.status, 403, status);
    assert.equal(response.body.error.code, 'account_inactive');
  }

  // Deleted.
  console_.fake.user(manager.sub).remove();
  response = await attempt();
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'account_inactive');

  assert.equal(console_.fake.objects.size, 0);
  assert.equal(console_.fake.releases.size, 0);

  // Reading was not asked about yet, so it is refused as well.
  response = await console_.call('GET', '/api/firmware', { as: manager });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'account_inactive');
});

test('Cognito, not the token, says who is a release manager', async () => {
  const console_ = createTestConsole();
  // Made a release manager after signing in: the token still says viewer. The change
  // counts at once for what the user may do, as a removal does.
  const promoted = console_.addUser('promoted', ['release-managers'], { tokenGroups: ['viewers'] });
  const response = await console_.call('POST', '/api/firmware', { as: promoted, body: upload() });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.release.uploadedBy, { sub: promoted.sub, email: promoted.email });
  assert.equal(console_.fake.auditLog().at(-1).outcome, 'ok');
  // What the console shows still follows the token, until the next sign-in.
  const me = await console_.call('GET', '/api/me', { as: promoted });
  assert.deepEqual([me.body.groups, me.body.canWrite], [['viewers'], false]);

  // A token without either group opens nothing, whatever Cognito would say.
  const outsider = console_.addUser('outsider', ['release-managers'], { tokenGroups: [] });
  const asks = () => console_.fake.calls.filter((call) => call.method === 'listUserGroups').length;
  const asked = asks();
  const refused = await console_.call('POST', '/api/firmware', { as: outsider, body: upload() });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'forbidden');
  assert.equal(asks(), asked);
  const refusedRead = await console_.call('GET', '/api/firmware', { as: outsider });
  assert.equal(refusedRead.status, 403);
  assert.equal(refusedRead.body.error.code, 'forbidden');
  assert.equal(asks(), asked);

  // The token in the forms the gateway sends for a member of both groups.
  for (const groups of [['release-managers'], ['viewers', 'release-managers']]) {
    const fresh = createTestConsole();
    const manager = fresh.addUser('manager', groups);
    assert.equal(manager.claims['cognito:groups'], `[${groups.join(' ')}]`);
    const accepted = await fresh.call('POST', '/api/firmware', { as: manager, body: upload() });
    assert.equal(accepted.status, 201);
    const asked = fresh.fake.methodsCalled();
    assert.ok(asked.indexOf('getUser') < asked.indexOf('putFirmwareObject'));
    assert.ok(asked.indexOf('listUserGroups') < asked.indexOf('putFirmwareObject'));
  }
});

test('a write is refused when Cognito cannot be asked', async () => {
  for (const method of ['getUser', 'listUserGroups']) {
    const console_ = createTestConsole();
    const manager = console_.addUser('manager', ['release-managers']);
    console_.fake.failNext(method);
    const response = await console_.call('POST', '/api/firmware', { as: manager, body: upload() });
    assert.equal(response.status, 500, method);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal(console_.fake.objects.size, 0);
    assert.equal(console_.fake.releases.size, 0);
  }
});

test('the live check is made again for every write', async () => {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  console_.fake.addThing(THING);
  assert.equal((await console_.call('POST', '/api/firmware', { as: manager, body: upload() })).status, 201);
  const checks = () => console_.fake.calls.filter((entry) => entry.method === 'listUserGroups').length;
  assert.equal(checks(), 1);

  console_.fake.user(manager.sub).setGroups([]);
  const response = await console_.call('POST', '/api/deployments',
    { as: manager, body: { version: '1.2.3+4', things: [THING] } });
  assert.equal(response.status, 403);
  assert.equal(checks(), 2);
  assert.equal(console_.fake.jobs.size, 0);
});

test('reading stops within a minute of an account being removed, disabled or left out', async () => {
  const changes = {
    removed: { change: (user) => user.remove(), code: 'account_inactive' },
    disabled: { change: (user) => user.disable(), code: 'account_inactive' },
    'back on a temporary password': { change: (user) => user.setStatus('FORCE_CHANGE_PASSWORD'), code: 'account_inactive' },
    'in no group': { change: (user) => user.setGroups([]), code: 'forbidden' },
  };
  for (const [name, { change, code }] of Object.entries(changes)) {
    const console_ = createTestConsole();
    const viewer = console_.addUser('viewer', ['viewers']);
    const read = () => console_.call('GET', '/api/devices', { as: viewer });
    assert.equal((await read()).status, 200, name);

    change(console_.fake.user(viewer.sub));
    // The last answer stands for up to a minute: this is the limit of the check.
    console_.advance(59 * 1000);
    assert.equal((await read()).status, 200, name);

    console_.advance(2 * 1000);
    const refused = await read();
    assert.equal(refused.status, 403, name);
    assert.equal(refused.body.error.code, code, name);
    assert.equal((await console_.call('GET', '/api/me', { as: viewer })).status, 403, name);
    // A path that does not exist says nothing to somebody who has been refused.
    assert.equal((await console_.call('GET', '/api/nothing', { as: viewer })).status, 403, name);
  }
});

test('the live check on reads asks once a minute for each user, and grants nothing', async () => {
  const console_ = createTestConsole();
  const viewer = console_.addUser('viewer', ['viewers']);
  const other = console_.addUser('other', ['viewers']);
  const asks = () => console_.fake.calls.filter((call) => call.method === 'listUserGroups').length;

  for (let poll = 0; poll < 20; poll += 1) {
    await console_.call('GET', '/api/devices', { as: viewer });
    console_.advance(2 * 1000);
  }
  assert.equal(asks(), 1);
  await console_.call('GET', '/api/devices', { as: other });
  assert.equal(asks(), 2);
  console_.advance(21 * 1000);
  await console_.call('GET', '/api/devices', { as: viewer });
  assert.equal(asks(), 3);

  // Membership on the Cognito side does not stand in for a token without a group.
  const outsider = console_.addUser('outsider', ['viewers'], { tokenGroups: [] });
  assert.equal((await console_.call('GET', '/api/devices', { as: outsider })).status, 403);

  // And what a viewer is shown does not grow with the group in Cognito.
  console_.fake.user(viewer.sub).setGroups(['release-managers']);
  console_.advance(61 * 1000);
  const me = await console_.call('GET', '/api/me', { as: viewer });
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.groups, me.body.canWrite], [['viewers'], false]);
});

test('when Cognito cannot be asked, reads go on and writes do not', async () => {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const asks = () => console_.fake.calls.filter((call) => call.method === 'listUserGroups').length;
  const failing = (method) => {
    console_.fake.failNext(method);
    console_.logs.length = 0;
  };

  // With nothing known yet, as after a cold start.
  failing('getUser');
  assert.equal((await console_.call('GET', '/api/devices', { as: manager, requestId: 'req-a' })).status, 200);
  const line = console_.logs.find((entry) => entry.event === 'live_check_failed');
  assert.equal(line.level, 'warn');
  assert.equal(line.requestId, 'req-a');
  assert.equal(line.sub, manager.sub);
  assert.equal(JSON.stringify(console_.logs).includes(manager.email), false);

  // It does not ask again for half a minute, so that an outage delays few requests.
  const asked = asks();
  console_.advance(29 * 1000);
  assert.equal((await console_.call('GET', '/api/devices', { as: manager })).status, 200);
  assert.equal(asks(), asked);

  // Writes do not wait for that, and do not take the benefit of the doubt.
  failing('listUserGroups');
  const write = await console_.call('POST', '/api/firmware', { as: manager, body: upload() });
  assert.equal(write.status, 500);
  assert.equal(console_.fake.objects.size, 0);

  // Then it asks again, and goes by the answer.
  console_.advance(2 * 1000);
  assert.equal((await console_.call('GET', '/api/devices', { as: manager })).status, 200);
  assert.ok(asks() > asked);

  // With a positive answer on record, a failure changes nothing.
  console_.advance(61 * 1000);
  failing('listUserGroups');
  assert.equal((await console_.call('GET', '/api/devices', { as: manager })).status, 200);
});

test('a refusal stays a refusal while Cognito cannot be asked', async () => {
  const console_ = createTestConsole();
  const viewer = console_.addUser('viewer', ['viewers']);
  const read = () => console_.call('GET', '/api/devices', { as: viewer });
  console_.fake.user(viewer.sub).disable();
  assert.equal((await read()).status, 403);

  // An outage is not a way back in, however long it lasts.
  for (let minute = 0; minute < 5; minute += 1) {
    console_.advance(61 * 1000);
    console_.fake.failNext('getUser');
    assert.equal((await read()).status, 403);
  }
  // And the account can come back.
  console_.fake.user(viewer.sub).enable();
  console_.advance(61 * 1000);
  assert.equal((await read()).status, 200);
});

test('the live check on reads never answers for a write', async () => {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  assert.equal((await console_.call('GET', '/api/firmware', { as: manager })).status, 200);

  // Well within the minute that a read would go by the last answer.
  console_.fake.user(manager.sub).remove();
  const write = await console_.call('POST', '/api/firmware', { as: manager, body: upload() });
  assert.equal(write.status, 403);
  assert.equal(write.body.error.code, 'account_inactive');
  assert.equal(console_.fake.objects.size, 0);
});

test('identity never comes from the request body', async () => {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const body = { ...upload(), sub: 'someone-else', email: 'forged', uploadedBy: { sub: 'x', email: 'y' }, actor: 'z' };
  const response = await console_.call('POST', '/api/firmware', { as: manager, body });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.release.uploadedBy, { sub: manager.sub, email: manager.email });
  assert.deepEqual(console_.fake.auditLog()[0].actor, { sub: manager.sub, email: manager.email });
});
