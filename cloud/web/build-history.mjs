#!/usr/bin/env node
/**
 * Write what the console's History page shows: site/assets/history.json. cloud/deploy.sh
 * runs this while it deploys. Git ignores the file, so a checkout that was never deployed
 * does not have it and the page says so.
 *
 *   node cloud/web/build-history.mjs [--repo <dir>] [--out <file>]
 *                                    [--commit <full id>] [--tree <clean|dirty|unknown>]
 *
 * Of a commit it keeps the short id, the full id, the date it was written (the author date:
 * a rebase or a merge moves the committer date of many commits to one moment), the subject
 * and which parts of the project it touched. Never who wrote it, and never the body of the message, where
 * Signed-off-by lines hold addresses. A subject can name an address too, so those are
 * taken out. Only the newest LIMIT commits are kept.
 *
 * The file is not left behind when anything fails: a stale list that looks current is
 * worse than none.
 *
 * No dependencies.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIMIT = 300;
const SUBJECT_MAX = 200;
const OUT = fileURLToPath(new URL('./src/site/assets/history.json', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HASH = /^[0-9a-f]{7,64}$/;

/**
 * What a change touched, worked out from its paths, in the order the page lists them. A
 * Markdown file counts as documentation wherever it lies, and as nothing else.
 */
export function tagsOf(paths) {
  const found = new Set();
  for (const path of paths) {
    if (path.startsWith('docs/') || /(^|\/)[^/]*\.md$/i.test(path)) found.add('docs');
    else if (path.startsWith('cloud/web/')) found.add('website');
    else if (path.startsWith('firmware/')) found.add('firmware');
    else if (path.startsWith('cloud/')) found.add('cloud');
    else if (path.startsWith('tools/')) found.add('tools');
    else if (path.startsWith('.github/')) found.add('ci');
  }
  return ['website', 'firmware', 'cloud', 'tools', 'ci', 'docs'].filter((tag) => found.has(tag));
}

/** A subject as it may be shown: no address in it, and of a sensible length. */
export function cleanSubject(subject) {
  const clean = subject.replace(ADDRESS, '(address removed)').trim();
  return clean.length > SUBJECT_MAX ? `${clean.slice(0, SUBJECT_MAX - 1)}…` : clean;
}

function git(repo, ...args) {
  return execFileSync('git', [
    '--no-optional-locks', '-C', repo, '-c', 'log.showSignature=false', '-c', 'core.quotepath=off', ...args,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The newest commits. A merge counts what it changed against its first parent. */
export function readCommits(repo, limit = LIMIT) {
  const text = git(repo, 'log', `--max-count=${limit}`, '--author-date-order', '--no-renames', '--diff-merges=first-parent',
    '--name-only', '--format=%x01%H%x00%h%x00%aI%x00%s%x00');
  const commits = [];
  for (const record of text.split('\u0001').slice(1)) {
    const [hash, short, date, subject, files] = record.split('\0');
    if (!HASH.test(hash) || files === undefined) throw new Error(`git log gave an unexpected record: ${hash}`);
    commits.push({
      short,
      hash,
      date,
      subject: cleanSubject(subject),
      tags: tagsOf(files.split('\n').filter(Boolean)),
    });
  }
  // By the date each one shows: a rebase can leave a commit under one written after it.
  return commits.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

export function buildHistory({ repo = REPO, commit, tree = 'unknown', now = new Date() } = {}) {
  const built = commit && commit !== 'unknown' ? commit : git(repo, 'rev-parse', '--verify', 'HEAD').trim();
  return {
    deployment: { commit: built, tree, deployedAt: now.toISOString() },
    commits: readCommits(repo),
  };
}

/**
 * Write the file so that the web function can read it. The function runs as another user
 * and the package keeps each file's permission bits, and deploy.sh runs with umask 077: a
 * file left at the default would stop the function from starting.
 */
export function writeHistory(history, out = OUT) {
  const work = `${out}.tmp`;
  writeFileSync(work, `${JSON.stringify(history)}\n`);
  chmodSync(work, 0o644);
  renameSync(work, out);
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(args) {
  const out = option(args, '--out') ?? OUT;
  rmSync(out, { force: true });
  try {
    const history = buildHistory({
      repo: option(args, '--repo') ?? REPO,
      commit: option(args, '--commit'),
      tree: option(args, '--tree') ?? 'unknown',
    });
    writeHistory(history, out);
    console.log(`Wrote ${history.commits.length} commits to ${out}`);
  } catch (error) {
    console.error(`The history could not be written: ${error.stderr?.toString().trim() || error.message}`);
    process.exitCode = 1;
  }
}

// Node gives this module's real path, and the command line whatever path it was called by.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2));
