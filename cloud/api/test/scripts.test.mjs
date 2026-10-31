// Tests for the shell scripts, with a stand-in for the AWS CLI first on the PATH: nothing
// here reaches AWS, and every call the scripts make is written down and looked at.
// A script's functions are run by loading it without its last line, which starts it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestConsole } from './fake-aws.mjs';

const CLOUD = fileURLToPath(new URL('../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'cranium-scripts-'));
after(() => rmSync(work, { recursive: true, force: true }));

// Answers from environment variables. STUB_FAIL names a call that fails.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL:-}" ]; then
  case "$*" in
    *"$STUB_FAIL"*) echo "stand-in failure" >&2; exit 254 ;;
  esac
fi
case "$*" in
  --version) echo "aws-cli/2.31.0" ;;
  "sts get-caller-identity"*) echo 123456789012 ;;
  *"--stack-name cranium-trail"*"StackStatus"*)
    if [ -n "\${STUB_TRAIL_STACK:-}" ]; then echo "$STUB_TRAIL_STACK"; else
      echo "Stack with id cranium-trail does not exist" >&2; exit 254; fi ;;
  "cloudformation describe-stacks"*) echo stand-in-output ;;
  "cloudtrail describe-trails"*) printf '%s\\n' "\${STUB_TRAILS:-}" ;;
  "cloudtrail get-trail-status"*) echo True ;;
  "cloudtrail get-trail "*) printf 'True\\tTrue\\n' ;;
  *"admin-get-user"*"--query UserStatus"*)
    if [ "\${STUB_STATUS:-CONFIRMED}" = NONE ]; then
      echo "An error occurred (UserNotFoundException)" >&2; exit 254; fi
    echo "\${STUB_STATUS:-CONFIRMED}" ;;
  *"admin-get-user"*"--query Enabled"*) echo "\${STUB_ENABLED:-True}" ;;
  *"admin-list-groups-for-user"*) echo "\${STUB_GROUPS:-}" ;;
  *"list-users-in-group"*) echo "" ;;
  *"cognito-idp list-users"*) printf 'sub-1\\tsomeone@example.org\\tCONFIRMED\\tTrue\\n' ;;
  *"dynamodb describe-table"*)
    if [ "\${STUB_TABLE:-False}" = GONE ]; then
      echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; fi
    echo "\${STUB_TABLE:-False}" ;;
esac
exit 0
`;

const stubDir = join(work, 'bin');
mkdirSync(stubDir);
writeFileSync(join(stubDir, 'aws'), STUB);
chmodSync(join(stubDir, 'aws'), 0o755);

let runs = 0;

/** The environment of a script: the stand-in first, and no trace of a real profile or git run. */
function environment(extra = {}) {
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('AWS_') && !name.startsWith('GIT_')));
  return { ...clean, PATH: `${stubDir}:${process.env.PATH}`, ...extra };
}

/** Run a command line under bash. Returns its status, its output and the AWS calls it made. */
function bash(args, env = {}) {
  runs += 1;
  const log = join(work, `calls-${runs}`);
  writeFileSync(log, '');
  const result = spawnSync('bash', args, { env: environment({ STUB_LOG: log, ...env }), encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '' && line !== '--version');
  return { status: result.status, out: result.stdout, err: result.stderr, calls };
}

const script = (name, ...args) => bash([join(CLOUD, name), ...args]);
const scriptWith = (env, name, ...args) => bash([join(CLOUD, name), ...args], env);

/** Run one line in a copy of a script that has everything but the call that starts it. */
function inScript(name, line, env = {}) {
  const text = readFileSync(join(CLOUD, name), 'utf8');
  assert.ok(text.trimEnd().endsWith('main "$@"'), name);
  runs += 1;
  const copy = join(work, `script-${runs}.sh`);
  writeFileSync(copy, `${text.trimEnd().slice(0, -'main "$@"'.length)}\n${line}\n`);
  return bash([copy], env);
}

const position = (calls, words) => calls.findIndex((call) => call.includes(words));

test('every script parses', () => {
  for (const name of ['deploy.sh', 'teardown.sh', 'users.sh', 'smoke.sh', 'trail.sh', 'logs.sh']) {
    const { status, err } = bash(['-n', join(CLOUD, name)]);
    assert.equal(status, 0, `${name}: ${err}`);
  }
});

test('reset-mfa replaces the account with the same role, and never sets a password', () => {
  for (const [groups, role, group] of [
    ['release-managers', 'release-manager', 'release-managers'],
    ['viewers', 'viewer', 'viewers'],
    ['release-managers viewers', 'release-manager', 'release-managers'],
  ]) {
    const { status, out, calls } = scriptWith({ STUB_GROUPS: groups }, 'users.sh', 'reset-mfa', 'a@example.org');
    assert.equal(status, 0, out);
    const order = ['admin-user-global-sign-out', 'admin-delete-user', 'admin-create-user', 'admin-add-user-to-group']
      .map((words) => position(calls, words));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), JSON.stringify(calls));
    assert.ok(order.every((at) => at !== -1), JSON.stringify(calls));
    assert.ok(calls[order[3]].includes(`--group-name ${group}`));
    assert.ok(out.includes(`cloud/users.sh add a@example.org ${role}`));
    assert.ok(out.includes('Done.'));
    // Cognito sends the password. The authenticator alone is no longer what goes.
    assert.equal(calls.some((call) => /password|delete-software-token/.test(call)), false);
  }
});

test('reset-mfa says how to finish before it deletes anything', () => {
  const { status, out, calls } = scriptWith(
    { STUB_GROUPS: 'release-managers', STUB_FAIL: 'admin-create-user' }, 'users.sh', 'reset-mfa', 'a@example.org');
  assert.notEqual(status, 0);
  assert.ok(position(calls, 'admin-delete-user') !== -1);
  assert.ok(out.includes('cloud/users.sh add a@example.org release-manager'));
  assert.equal(out.includes('Done.'), false);
});

test('reset-mfa leaves an account alone when replacing it would change more than it should', () => {
  const cases = [
    [{ STUB_ENABLED: 'False', STUB_GROUPS: 'viewers' }, 'disabled'],
    [{ STUB_GROUPS: '' }, 'no role'],
    [{ STUB_STATUS: 'FORCE_CHANGE_PASSWORD', STUB_GROUPS: 'viewers' }, 'resend'],
    [{ STUB_STATUS: 'NONE' }, 'There is no account'],
  ];
  for (const [env, words] of cases) {
    const { status, out, err, calls } = scriptWith(env, 'users.sh', 'reset-mfa', 'a@example.org');
    assert.notEqual(status, 0, words);
    assert.ok(`${out}${err}`.includes(words), `${words}: ${out}${err}`);
    for (const change of ['admin-delete-user', 'admin-create-user', 'admin-user-global-sign-out', 'admin-add-user-to-group']) {
      assert.equal(position(calls, change), -1, `${words}: ${change}`);
    }
  }
});

test('removing an address that has no account does not look like a success', () => {
  const missing = scriptWith({ STUB_STATUS: 'NONE' }, 'users.sh', 'remove', 'gone@example.org');
  assert.notEqual(missing.status, 0);
  assert.ok(missing.err.includes('There is no account for gone@example.org'));
  assert.ok(missing.err.includes('someone@example.org'), 'the current accounts are shown');
  assert.equal(position(missing.calls, 'admin-delete-user'), -1);

  const found = script('users.sh', 'remove', 'a@example.org');
  assert.equal(found.status, 0);
  assert.ok(position(found.calls, 'admin-delete-user') !== -1);
  assert.ok(found.out.includes('within a minute'));
});

test('adding an address that has no account says what happens to one elsewhere', () => {
  const { status, out } = scriptWith({ STUB_STATUS: 'NONE', STUB_GROUPS: 'viewers' }, 'users.sh', 'add', 'new@example.org', 'viewer');
  assert.equal(status, 0);
  assert.ok(out.includes('cloud/users.sh list'));
});

test('users.sh list keeps the form that scripts/ota.sh reads', () => {
  const { status, out } = script('users.sh', 'list');
  assert.equal(status, 0);
  assert.match(out, /^E-MAIL\s+ROLE\s+STATE\n/);
  assert.match(out, /someone@example\.org\s+none\s+active\n/);
});

test('teardown switches a table\'s deletion protection off first', () => {
  const protectedTable = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'True' });
  assert.equal(protectedTable.status, 0, protectedTable.err);
  const order = ['describe-table', 'update-table --table-name t1 --no-deletion-protection-enabled',
    'wait table-exists', 'delete-table --table-name t1', 'wait table-not-exists']
    .map((words) => position(protectedTable.calls, words));
  assert.ok(order.every((at) => at !== -1), JSON.stringify(protectedTable.calls));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));

  const open = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'False' });
  assert.equal(open.status, 0);
  assert.equal(position(open.calls, 'update-table'), -1);
  assert.ok(position(open.calls, 'delete-table') !== -1);

  // It can be run again if it stopped halfway.
  const gone = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'GONE' });
  assert.equal(gone.status, 0, gone.err);
  assert.ok(gone.out.includes('already gone'));
  assert.equal(position(gone.calls, 'delete-table'), -1);

  const unknown = inScript('teardown.sh', 'delete_table "audit table" ""');
  assert.equal(unknown.status, 0);
  assert.deepEqual(unknown.calls, []);

  const refused = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'True', STUB_FAIL: 'update-table' });
  assert.notEqual(refused.status, 0);
  assert.equal(position(refused.calls, 'delete-table'), -1);
});

test('deploy.sh tells the commit and which deployed files differ from it', () => {
  const repo = join(work, 'repo');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.org',
      '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8', env: { ...environment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const place = (path, text = 'x\n') => {
    const file = join(repo, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  const state = (line) => inScript('deploy.sh', `REPO_DIR=${repo}; ${line}`,
    { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

  // No checkout at all.
  mkdirSync(repo);
  assert.equal(state('source_commit').out.trim(), 'unknown');

  git('init', '-q');
  for (const path of ['cloud/api/src/index.mjs', 'cloud/web/src/server.mjs', 'cloud/infra/template.yaml',
    'firmware/keys/fw_signing_pub.pem', 'firmware/app/src/main.c', 'README.md']) {
    place(path);
  }
  place('.gitignore', '.DS_Store\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const head = git('rev-parse', 'HEAD');
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(state('source_commit').out.trim(), head);
  assert.equal(state('source_changes').out, '');

  // What is not deployed does not count.
  place('firmware/app/src/main.c', 'changed\n');
  place('notes.pdf');
  place('scripts/new.sh');
  assert.equal(state('source_changes').out, '');

  // What is deployed does: changed, new, ignored but packaged, and the signing key.
  const changed = [
    ['cloud/api/src/index.mjs', 'changed\n'], ['cloud/web/src/new.mjs', 'new\n'],
    ['cloud/web/src/.DS_Store', 'ignored\n'], ['cloud/infra/template.yaml', 'changed\n'],
    ['firmware/keys/fw_signing_pub.pem', 'changed\n'],
  ];
  for (const [path, text] of changed) {
    place(path, text);
    assert.ok(state('source_changes').out.includes(path), path);
  }
  // Except the history file, which this script writes from the commits themselves.
  const before = state('source_changes').out;
  place('cloud/web/src/site/assets/history.json', '{}\n');
  assert.equal(state('source_changes').out, before);
  // And none of this looked at the checkout in a way that changes it.
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('deploy.sh does not take the commit from the command line', () => {
  for (const argument of ['DeployedCommit=abc', 'DeployedTree=clean']) {
    const { status, err, calls } = script('deploy.sh', argument);
    assert.equal(status, 1);
    assert.ok(err.includes('unknown argument'));
    assert.deepEqual(calls, []);
  }
  // The new switch is known, which the refusal above shows it would not be otherwise.
  const text = readFileSync(join(CLOUD, 'deploy.sh'), 'utf8');
  assert.ok(text.includes('RestrictIotLoggingTrust=*'));
});

test('trail.sh deploys its own stack, and not next to another trail', () => {
  const alone = scriptWith({ STUB_TRAIL_STACK: '' }, 'trail.sh');
  assert.equal(alone.status, 0, alone.err);
  const deploy = alone.calls.find((call) => call.startsWith('cloudformation deploy'));
  assert.ok(deploy.includes('--stack-name cranium-trail'));
  assert.ok(deploy.includes('infra/trail.yaml'));
  // The stack has no role, so it needs no such right.
  assert.equal(deploy.includes('--capabilities'), false);

  const second = scriptWith({ STUB_TRAILS: 'other-trail\tus-east-1' }, 'trail.sh');
  assert.notEqual(second.status, 0);
  assert.ok(second.err.includes('$2.00 per 100,000'));
  assert.equal(second.calls.some((call) => call.startsWith('cloudformation deploy')), false);

  const status = scriptWith({ STUB_TRAIL_STACK: 'CREATE_COMPLETE' }, 'trail.sh', '--status');
  assert.equal(status.status, 0, status.err);
  assert.ok(status.out.includes('Logging: True'));
  assert.equal(status.calls.some((call) => call.startsWith('cloudformation deploy')), false);

  const none = scriptWith({ STUB_TRAIL_STACK: '' }, 'trail.sh', '--status');
  assert.equal(none.status, 0);
  assert.ok(none.out.includes('NONE'));
});

test('the event smoke.sh sends is one the API function takes, and it tells the two cases apart', async () => {
  const console_ = createTestConsole();
  const member = console_.addUser('member', ['release-managers']);
  const eventFor = (sub) => {
    const { status, out, err } = inScript('smoke.sh',
      `API_HOST=abc.example.org; CLIENT_ID=${console_.config.userPoolClientId}; USER_POOL_ID=pool_1; api_event /api/devices ${sub}`);
    assert.equal(status, 0, err);
    return JSON.parse(out);
  };

  const real = eventFor(member.sub);
  assert.equal(real.routeKey, 'GET /api/{proxy+}');
  assert.equal((await console_.app(real)).statusCode, 200);

  const unknown = await console_.app(eventFor('00000000-0000-0000-0000-000000000000'));
  assert.equal(unknown.statusCode, 403);
  assert.equal(JSON.parse(unknown.body).error.code, 'account_inactive');
  // Writes nothing: this is a read, whoever it claims to be.
  assert.equal(console_.fake.auditLog().length, 0);
});
