/**
 * Tests for the History page and the script that writes its data. The script runs against
 * a repository made for the test, in a temporary directory, with the git on this machine.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LIMIT, buildHistory, cleanSubject, readCommits, tagsOf, writeHistory,
} from '../build-history.mjs';
import { loadSite } from '../src/server.mjs';
import {
  HISTORY, VIEWS, all, click, createDocument, one, textOf,
} from './page.mjs';

const history = await import(HISTORY);
const views = await import(VIEWS);
globalThis.document = createDocument();

const SCRIPT = fileURLToPath(new URL('../build-history.mjs', import.meta.url));
const SITE = fileURLToPath(new URL('../src/site/', import.meta.url));
const ADDRESS = 'author@people.example';
const NOW = Date.parse('2026-10-31T12:00:00Z');

const work = mkdtempSync(join(tmpdir(), 'cranium-history-'));
after(() => rmSync(work, { recursive: true, force: true }));

// A repository of its own: nothing here can look at the real one.
const repo = join(work, 'repo');
mkdirSync(repo);
function git(...args) {
  return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Some Author',
      GIT_AUTHOR_EMAIL: ADDRESS,
      GIT_COMMITTER_NAME: 'Some Committer',
      GIT_COMMITTER_EMAIL: ADDRESS,
      GIT_AUTHOR_DATE: '2026-10-25T15:14:58-04:00',
      GIT_COMMITTER_DATE: '2026-10-25T15:14:58-04:00',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}
function commit(path, subject, body = '') {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), `${subject}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  return git('rev-parse', 'HEAD');
}
git('init', '-q', '-b', 'main');
commit('cloud/web/src/site/assets/app.js', 'Change the website');
commit('firmware/app/src/main.c', 'Change the firmware');
commit('cloud/api/src/app.mjs', 'Change the API');
commit('tools/board.py', 'Change a tool');
commit('docs/aws-iot.md', 'Change the documents');
commit('firmware/README.md', 'A Markdown file is documentation');
commit('.gitignore', 'Touch nothing in particular');
const NEWEST = commit('cloud/web/x.mjs', `Credit ${ADDRESS} in a subject`,
  `Signed-off-by: Somebody <${ADDRESS}>\n\nA body that must not travel.`);

// The data.

test('what a commit touched is worked out from its paths, in a fixed order', () => {
  assert.deepEqual(tagsOf(['cloud/web/src/server.mjs']), ['website']);
  assert.deepEqual(tagsOf(['cloud/api/src/app.mjs', 'cloud/deploy.sh', 'cloud/dev/preview.mjs']), ['cloud']);
  assert.deepEqual(tagsOf(['firmware/app/src/main.c']), ['firmware']);
  assert.deepEqual(tagsOf(['tools/board.py']), ['tools']);
  assert.deepEqual(tagsOf(['.github/workflows/ci.yml']), ['ci']);
  assert.deepEqual(tagsOf(['docs/x.txt', 'README.md', 'cloud/README.md', 'firmware/README.md', '.github/x.md']), ['docs']);
  assert.deepEqual(tagsOf(['docs/a.md', '.github/f.yml', 'tools/b.py', 'cloud/c.sh', 'firmware/d.c', 'cloud/web/e.js']),
    ['website', 'firmware', 'cloud', 'tools', 'ci', 'docs']);
  assert.deepEqual(tagsOf(['.gitignore', 'binaries/x.bin']), []);
});

test('the page and the script list the same tags in the same order', () => {
  const everything = tagsOf(['cloud/web/a', 'firmware/b', 'cloud/c', 'tools/d', '.github/f', 'docs/e']);
  assert.deepEqual(history.TAGS.map(([tag]) => tag), everything);
});

test('a subject loses addresses, and very long ones are cut', () => {
  assert.equal(cleanSubject(`Fix for ${ADDRESS}, thanks`), 'Fix for (address removed), thanks');
  assert.equal(cleanSubject('x'.repeat(500)).length, 200);
});

test('each commit has a short id, a full id, a date, a subject and tags, and nothing else', () => {
  const { commits } = buildHistory({ repo, commit: NEWEST, tree: 'clean', now: new Date(NOW) });
  assert.equal(commits.length, 8);
  assert.equal(commits[0].hash, NEWEST, 'newest first');
  assert.equal(commits.at(-1).subject, 'Change the website');
  for (const item of commits) {
    assert.deepEqual(Object.keys(item).sort(), ['date', 'hash', 'short', 'subject', 'tags']);
    assert.match(item.hash, /^[0-9a-f]{40}$/);
    assert.equal(item.hash.startsWith(item.short), true);
    assert.equal(Number.isNaN(Date.parse(item.date)), false);
  }
  const byTag = Object.fromEntries(commits.map((item) => [item.subject, item.tags]));
  assert.deepEqual(byTag['Change the firmware'], ['firmware']);
  assert.deepEqual(byTag['A Markdown file is documentation'], ['docs']);
  assert.deepEqual(byTag['Touch nothing in particular'], []);
});

test('no address and no body get into the file, from the author, the subject or the message', () => {
  const out = join(work, 'clean.json');
  writeHistory(buildHistory({ repo, commit: NEWEST, tree: 'clean' }), out);
  const text = readFileSync(out, 'utf8');
  assert.equal(text.includes(ADDRESS), false);
  assert.equal(text.includes('Some Author'), false);
  assert.equal(text.includes('Some Committer'), false);
  assert.equal(text.includes('Signed-off-by'), false);
  assert.equal(text.includes('must not travel'), false);
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
});

test('it says what the deployment was built from, and when', () => {
  const built = buildHistory({ repo, commit: NEWEST, tree: 'dirty', now: new Date(NOW) });
  assert.deepEqual(built.deployment, { commit: NEWEST, tree: 'dirty', deployedAt: new Date(NOW).toISOString() });
  // Run by hand, it looks up the commit and does not claim to know the state of the tree.
  assert.deepEqual(buildHistory({ repo, now: new Date(NOW) }).deployment,
    { commit: NEWEST, tree: 'unknown', deployedAt: new Date(NOW).toISOString() });
});

test('a commit is dated by when it was written, not by when it was last rewritten', () => {
  const rewritten = join(work, 'rewritten');
  mkdirSync(rewritten);
  // A rebase leaves the committer date of all of them at one moment.
  const written = [1700000000, 1700090000, 1700180000];
  let stream = '';
  written.forEach((at, index) => {
    stream += `commit refs/heads/main\nauthor A <${ADDRESS}> ${at} +0000\ncommitter A <${ADDRESS}> 1700999000 +0000\n` +
      `data ${`commit ${index}`.length}\ncommit ${index}\nM 100644 inline tools/f\ndata 1\n${index}\n\n`;
  });
  execFileSync('git', ['-C', rewritten, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', rewritten, 'fast-import', '--quiet'], { input: stream });
  const { commits } = buildHistory({ repo: rewritten });
  assert.deepEqual(commits.map((item) => item.subject), ['commit 2', 'commit 1', 'commit 0']);
  assert.deepEqual(commits.map((item) => Date.parse(item.date) / 1000), [...written].reverse());
});

test('commits stand in the order of the dates they show, whatever order a rebase left them in', () => {
  const reordered = join(work, 'reordered');
  mkdirSync(reordered);
  // The second commit in the history was written before the first.
  const written = [1700090000, 1700000000, 1700180000];
  let stream = '';
  written.forEach((at, index) => {
    stream += `commit refs/heads/main\nauthor A <${ADDRESS}> ${at} +0000\ncommitter A <${ADDRESS}> 1700999000 +0000\n` +
      `data ${`commit ${index}`.length}\ncommit ${index}\nM 100644 inline tools/f\ndata 1\n${index}\n\n`;
  });
  execFileSync('git', ['-C', reordered, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', reordered, 'fast-import', '--quiet'], { input: stream });
  const { commits } = buildHistory({ repo: reordered });
  assert.deepEqual(commits.map((item) => item.subject), ['commit 2', 'commit 0', 'commit 1']);
});

test('of two branches, the commits kept are the newest by the date they show', () => {
  const branched = join(work, 'branched');
  mkdirSync(branched);
  const commit = (ref, mark, subject, written, committed, parents = '') =>
    `commit refs/heads/${ref}\nmark :${mark}\nauthor A <${ADDRESS}> ${written} +0000\ncommitter A <${ADDRESS}> ${committed} +0000\n` +
    `data ${subject.length}\n${subject}\n${parents}M 100644 inline tools/${mark}\ndata 1\nx\n\n`;
  // Rewritten since: "written last" carries an old committer date, "written first" a new one.
  const stream = commit('main', 1, 'root', 1700000000, 1700000000) +
    commit('late', 2, 'written last', 1700300000, 1700100000, 'from :1\n') +
    commit('early', 3, 'written first', 1700100000, 1700300000, 'from :1\n') +
    commit('main', 4, 'merged', 1700400000, 1700400000, 'from :2\nmerge :3\n');
  execFileSync('git', ['-C', branched, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', branched, 'fast-import', '--quiet'], { input: stream });
  assert.deepEqual(readCommits(branched, 2).map((item) => item.subject), ['merged', 'written last']);
});

test('only the newest commits are kept', () => {
  const big = join(work, 'big');
  mkdirSync(big);
  const count = LIMIT + 5;
  let stream = '';
  for (let at = 1; at <= count; at += 1) {
    stream += `commit refs/heads/main\ncommitter A <${ADDRESS}> ${1700000000 + at} +0000\ndata ${`commit ${at}`.length}\ncommit ${at}\n` +
      `M 100644 inline tools/f\ndata ${String(at).length}\n${at}\n\n`;
  }
  execFileSync('git', ['-C', big, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', big, 'fast-import', '--quiet'], { input: stream });
  const { commits } = buildHistory({ repo: big });
  assert.equal(LIMIT, 300);
  assert.equal(commits.length, 300);
  assert.equal(commits[0].subject, `commit ${count}`);
  assert.equal(commits.at(-1).subject, `commit ${count - 299}`);
  assert.deepEqual(commits[0].tags, ['tools']);
});

test('the file can be read by the function, whatever umask the deployment runs with', () => {
  const out = join(work, 'umask.json');
  const run = spawnSync('sh', ['-c', 'umask 077; exec "$0" "$@"', process.execPath, SCRIPT, '--repo', repo,
    '--out', out, '--commit', NEWEST, '--tree', 'clean'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).deployment.tree, 'clean');
});

test('it runs when it is called through a link, as a checkout under a linked directory does', () => {
  const link = join(work, 'linked-script.mjs');
  const out = join(work, 'through-link.json');
  symlinkSync(SCRIPT, link);
  const run = spawnSync(process.execPath, [link, '--repo', repo, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(out), true);
});

test('when git cannot say, the old file does not stay behind looking current', () => {
  const out = join(work, 'stale.json');
  writeFileSync(out, '{"commits":[]}\n');
  const elsewhere = join(work, 'no-repository');
  mkdirSync(elsewhere);
  const run = spawnSync(process.execPath, [SCRIPT, '--repo', elsewhere, '--out', out], {
    encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: work },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /could not be written/);
  assert.equal(existsSync(out), false);
});

// Serving it.

test('it is a file of the console and only of the console, served as JSON', () => {
  const site = join(work, 'site');
  cpSync(SITE, site, { recursive: true });
  const base = pathToFileURL(`${site}/`);
  rmSync(join(site, 'assets', 'history.json'), { force: true });
  const before = loadSite(base);
  writeFileSync(join(site, 'assets', 'history.json'), '{"commits":[]}\n');
  const withFile = loadSite(base);

  const path = `/assets/${withFile.console.buildId}/history.json`;
  assert.deepEqual({ ...withFile.console.assets.get(path) },
    { type: 'application/json; charset=utf-8', body: '{"commits":[]}\n' });
  assert.notEqual(withFile.console.buildId, before.console.buildId, 'a new list is a new build of the console');
  assert.equal(withFile.home.buildId, before.home.buildId, 'and no change at all to the home page');
  assert.equal([...withFile.home.assets.keys()].some((name) => name.includes('history')), false);
  assert.equal(withFile.home.page.includes('history'), false);

  // The console starts without it, and a home page file by that type is still refused.
  writeFileSync(join(site, 'assets', 'home.json'), '{}');
  assert.throws(() => loadSite(base), /Unexpected entry/);
});

// The page.

const COMMITS = [
  { short: 'aaaaaaa', hash: 'a'.repeat(40), date: '2026-10-31T10:00:00Z', subject: 'Add the history page', tags: ['website', 'docs'] },
  { short: 'bbbbbbb', hash: 'b'.repeat(40), date: '2026-10-30T10:00:00Z', subject: 'Fix the firmware', tags: ['firmware'] },
  { short: 'ccccccc', hash: 'c'.repeat(40), date: '2026-10-20T10:00:00Z', subject: 'Touch the root', tags: [] },
];
const FILE = {
  deployment: { commit: 'a'.repeat(40), tree: 'clean', deployedAt: '2026-10-31T11:00:00Z' },
  commits: COMMITS,
};

function pageWith(value, { canWrite = true } = {}) {
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  const ctx = {
    state: { now: NOW, me: { canWrite }, commits: { value, error: null, loading: false } },
    actions: { redraw: () => views.render(box, history.historyView(ctx)) },
  };
  ctx.actions.redraw();
  return box;
}

const parsed = (changes = {}) => history.parseHistory({ ...FILE, ...changes });

test('the timeline shows date, subject, tags and a link to the commit, newest first', () => {
  const box = pageWith(parsed());
  const rows = all(box, 'li.history-row');
  assert.deepEqual(rows.map((row) => textOf(one(row, 'p.history-subject'))),
    ['Add the history page', 'Fix the firmware', 'Touch the root']);
  const [link] = all(rows[1], 'a');
  assert.equal(textOf(link), 'bbbbbbb');
  assert.equal(link.getAttribute('href'), `https://github.com/ese5180/f26-t07-the-cranium/commit/${'b'.repeat(40)}`);
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(one(rows[1], 'time').getAttribute('datetime'), '2026-10-30T10:00:00Z');
  assert.deepEqual(all(rows[0], 'span.tag').map(textOf), ['Website', 'Docs']);
  assert.deepEqual(all(rows[2], 'span.tag'), []);
  assert.deepEqual(all(box, 'h2.log-day-title').map(textOf).slice(0, 2), ['Today', 'Yesterday']);
  assert.equal(all(box, 'h1').length, 1);
});

test('it shows what this deployment was built from, whether that was clean, and when', () => {
  const panel = (tree) => textOf(one(pageWith(parsed({ deployment: { ...FILE.deployment, tree } })), 'section.history-panel'));
  assert.match(panel('clean'), /aaaaaaa/);
  assert.match(panel('clean'), /Add the history page/);
  assert.match(panel('clean'), /Clean/);
  assert.match(panel('clean'), /1 h ago|60 min ago/);
  assert.match(panel('dirty'), /Not clean/);
  assert.match(panel('dirty'), /differed from this commit/);
  assert.match(panel('whatever'), /Not known/);
  // Marked in the list as well, and a state is never colour alone.
  const box = pageWith(parsed());
  assert.match(textOf(all(box, 'li.history-row')[0]), /This deployment/);
  assert.equal(all(all(box, 'li.history-row')[1], 'span.badge').length, 0);
  assert.equal(all(one(box, 'section.history-panel'), 'p.status')[0].childNodes.length, 2);
});

test('the filter keeps the commits that touched a part, and says so', () => {
  const box = pageWith(parsed());
  const choice = (word) => one(box, 'button.history-choice', word);
  const subjects = () => all(box, 'p.history-subject').map(textOf);
  assert.match(textOf(choice('All')), /3$/);
  assert.match(textOf(choice('Firmware')), /1$/);
  assert.equal(choice('All').getAttribute('aria-pressed'), 'true');

  click(choice('Firmware'));
  assert.deepEqual(subjects(), ['Fix the firmware']);
  assert.equal(choice('Firmware').getAttribute('aria-pressed'), 'true');
  assert.equal(choice('All').getAttribute('aria-pressed'), 'false');
  assert.match(textOf(one(box, 'p.history-summary')), /1 of 3 commits touched firmware/);

  click(choice('Tools'));
  assert.deepEqual(subjects(), []);
  assert.match(textOf(box), /No commit here touched that/);
  click(choice('All'));
  assert.equal(subjects().length, 3);
});

test('without the file the page says so plainly, and with a broken one it says that', async () => {
  const replying = (response) => async () => response;
  assert.deepEqual(await history.readHistory(replying(new Response('Not found', { status: 404 }))), { missing: true });
  assert.match(textOf(pageWith({ missing: true })), /no history in this copy/);
  assert.match(textOf(pageWith({ missing: true })), /never was/);

  for (const broken of [new Response('nonsense'), new Response('{"commits":"x"}'), new Response('', { status: 500 }),
    Response.json({ commits: [{ hash: '"><script>', subject: 'x', date: 'y' }] })]) {
    const result = await history.readHistory(replying(broken));
    assert.match(result.failed, /could not be read/);
    assert.match(textOf(pageWith(result)), /could not be read/);
  }
  const unreachable = await history.readHistory(async () => { throw new TypeError('offline'); });
  assert.match(unreachable.failed, /could not be fetched/);
});

test('it fetches the file beside its own script, with no sign-in token', async () => {
  const asked = [];
  await history.readHistory(async (...args) => {
    asked.push(args);
    return Response.json(FILE);
  });
  assert.deepEqual(asked, [['https://console.test/assets/build/history.json']]);
});

test('no more than the bound is shown, and what is unknown in the file is left out', () => {
  const many = Array.from({ length: 320 }, (_, at) => ({
    short: 'abcdef0', hash: `${at.toString(16).padStart(7, '0')}`, date: FILE.commits[0].date, subject: 's', tags: ['website', 'nonsense'],
  }));
  const result = parsed({ commits: many });
  assert.equal(result.commits.length, 300);
  assert.deepEqual(result.commits[0].tags, ['website']);
  assert.match(textOf(one(pageWith(result), 'p.history-summary')), /The newest 300 commits/);
});

test('the file on disk, where this checkout has one, holds what it may', { skip: !existsSync(join(SITE, 'assets', 'history.json')) }, () => {
  const text = readFileSync(join(SITE, 'assets', 'history.json'), 'utf8');
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const data = JSON.parse(text);
  assert.equal(data.commits.length <= 300, true);
  assert.notEqual(history.parseHistory(data), null);
});
