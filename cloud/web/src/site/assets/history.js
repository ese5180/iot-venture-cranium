/**
 * The history page: the project's commits, newest first, and what this deployment was
 * built from. The data is history.json next to this script, written at deployment by
 * cloud/web/build-history.mjs. A checkout that was never deployed does not have it.
 *
 * Loaded when the page is first opened, so a cold load of the console stays as it was.
 *
 * No dependencies.
 */

import { dayLabel, exactTime, plural, timeAgo } from './core.js';
import {
  badge, button, developerTabs, empty, h, icon, loading, mono, notice, pageHead,
} from './views.js';

// A link that a person follows. Nothing is fetched from there.
const COMMIT_BASE = 'https://github.com/ese5180/f26-t07-the-cranium/commit/';
const COMMITS_KEPT = 300;
const HASH = /^[0-9a-f]{7,64}$/;

// The same names in the same order as cloud/web/build-history.mjs.
export const TAGS = Object.freeze([
  ['website', 'Website'],
  ['firmware', 'Firmware'],
  ['cloud', 'Cloud'],
  ['tools', 'Tools'],
  ['ci', 'CI'],
  ['docs', 'Docs'],
]);
const TAG_NAMES = new Map(TAGS);

const NOT_READABLE = 'The history file could not be read. Reload the page to try again.';

/** The file's data with only what the page uses, or null if it is not what was written. */
export function parseHistory(data) {
  if (!Array.isArray(data?.commits)) return null;
  const commits = [];
  for (const commit of data.commits.slice(0, COMMITS_KEPT)) {
    if (!HASH.test(commit?.hash) || typeof commit.subject !== 'string' || typeof commit.date !== 'string') return null;
    commits.push({
      hash: commit.hash,
      short: typeof commit.short === 'string' ? commit.short : commit.hash.slice(0, 7),
      date: commit.date,
      subject: commit.subject,
      tags: Array.isArray(commit.tags) ? commit.tags.filter((tag) => TAG_NAMES.has(tag)) : [],
    });
  }
  const built = data.deployment;
  return {
    commits,
    deployment: {
      commit: HASH.test(built?.commit) ? built.commit : null,
      tree: ['clean', 'dirty'].includes(built?.tree) ? built.tree : 'unknown',
      deployedAt: typeof built?.deployedAt === 'string' ? built.deployedAt : null,
    },
  };
}

/**
 * Fetch the file from beside this script, under the same build id. Tells apart a file
 * that is not there from one that could not be fetched; neither is a fault of the page.
 */
export async function readHistory(fetch, address = new URL('history.json', import.meta.url).href) {
  let response;
  try {
    response = await fetch(address);
  } catch {
    return { failed: 'The history file could not be fetched. Check the connection and reload the page.' };
  }
  if (response.status === 404) return { missing: true };
  if (!response.ok) return { failed: NOT_READABLE };
  try {
    return parseHistory(await response.json()) ?? { failed: NOT_READABLE };
  } catch {
    return { failed: NOT_READABLE };
  }
}

// The filter is the reader's only choice here. It is not worth an address of its own.
let shownTag = 'all';

function commitLink(hash, short) {
  return h('a', {
    class: 'history-hash mono',
    href: `${COMMIT_BASE}${hash}`,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: `Commit ${hash} on GitHub`,
    'aria-label': `Commit ${short} on GitHub, opens in a new tab`,
  }, short);
}

const TREES = {
  clean: ['good', 'check-circle', 'Clean', 'The files that went out matched this commit.'],
  dirty: ['warn', 'alert', 'Not clean', 'Some of the files that went out differed from this commit.'],
  unknown: ['idle', 'minus-circle', 'Not known', 'This deployment did not record it.'],
};

function deploymentPanel({ deployment, commits }, now) {
  const { commit, tree, deployedAt } = deployment;
  const [tone, iconName, word, meaning] = TREES[tree];
  const built = commits.find((item) => item.hash === commit);
  return h('section', { class: 'panel on-ink history-panel', key: 'panel', 'aria-label': 'This deployment' },
    h('div', { class: 'history-built' },
      h('h2', { class: 'eyebrow' }, 'This deployment was built from'),
      commit
        ? h('p', { class: 'history-figure' }, commitLink(commit, built?.short ?? commit.slice(0, 7)))
        : h('p', { class: 'history-figure' }, 'An unknown commit'),
      built ? h('p', { class: 'history-built-subject' }, built.subject) : null),
    h('div', { class: 'history-fact' },
      h('h2', { class: 'eyebrow' }, 'Its files'),
      h('p', { class: `status is-${tone} history-state` }, icon(iconName), word),
      h('p', { class: 'history-note' }, meaning)),
    h('div', { class: 'history-fact' },
      h('h2', { class: 'eyebrow' }, 'Deployed'),
      deployedAt
        ? [
          h('p', { class: 'history-state' }, h('time', { datetime: deployedAt, title: exactTime(deployedAt) }, timeAgo(deployedAt, now))),
          h('p', { class: 'history-note' }, exactTime(deployedAt)),
        ]
        : h('p', { class: 'history-state' }, 'Not known')));
}

function tagFilter(commits, ctx) {
  const choose = (tag) => () => {
    shownTag = tag;
    ctx.actions.redraw();
  };
  const choice = (tag, label, count) => h('button', {
    type: 'button',
    key: tag,
    class: 'btn is-small history-choice',
    'aria-pressed': shownTag === tag ? 'true' : 'false',
    onClick: choose(tag),
  },
  shownTag === tag ? icon('check') : null,
  label,
  h('span', { class: 'history-count' }, String(count)));
  return h('div', { class: 'history-filter', key: 'filter', role: 'group', 'aria-label': 'Show the commits that touched' },
    choice('all', 'All', commits.length),
    TAGS.map(([tag, label]) => choice(tag, label, commits.filter((commit) => commit.tags.includes(tag)).length)));
}

function commitRow(commit, deployed) {
  const here = commit.hash === deployed;
  return h('li', { key: commit.hash, class: `history-row ${here ? 'is-deployed' : ''}`.trim() },
    h('time', { class: 'history-time', datetime: commit.date, title: exactTime(commit.date) },
      new Date(commit.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
    h('div', { class: 'history-body' },
      h('p', { class: 'history-subject' }, commit.subject),
      commit.tags.length > 0 || here
        ? h('p', { class: 'history-tags' },
          here ? badge('idle', 'package', 'This deployment') : null,
          commit.tags.map((tag) => h('span', { key: tag, class: 'tag' }, TAG_NAMES.get(tag))))
        : null),
    commitLink(commit.hash, commit.short));
}

function timeline(commits, deployed, now) {
  const days = [];
  for (const commit of commits) {
    const label = dayLabel(commit.date, now);
    if (days.at(-1)?.label !== label) days.push({ label, commits: [] });
    days.at(-1).commits.push(commit);
  }
  return days.map((day) => h('section', { key: day.label, class: 'log-day' },
    h('h2', { class: 'log-day-title' }, day.label),
    h('ol', { class: 'history-list' }, day.commits.map((commit) => commitRow(commit, deployed)))));
}

function historyBody(ctx) {
  const resource = ctx.state.commits;
  const data = resource.value;
  if (!data) return loading('the history');
  if (data.missing) {
    return h('section', { class: 'card', key: 'missing' }, empty({
      iconName: 'list',
      title: 'There is no history in this copy of the console.',
      text: 'The list of commits is written when the console is deployed, and this copy never was. ' +
        'To see the page here, write the file by hand:',
      command: 'node cloud/web/build-history.mjs',
    }));
  }
  if (data.failed) {
    return notice('bad', 'alert', data.failed, { action: button('is-small', () => location.reload(), 'Reload') });
  }
  const { commits, deployment } = data;
  const shown = shownTag === 'all' ? commits : commits.filter((commit) => commit.tags.includes(shownTag));
  return [
    deploymentPanel(data, ctx.state.now),
    tagFilter(commits, ctx),
    h('p', { class: 'history-summary', key: 'summary', role: 'status' },
      shownTag === 'all'
        ? `${commits.length >= COMMITS_KEPT ? 'The newest ' : ''}${plural(commits.length, 'commit')}`
        : `${shown.length} of ${plural(commits.length, 'commit')} touched ${TAG_NAMES.get(shownTag).toLowerCase()}`,
      '. Each hash opens the commit on GitHub.'),
    shown.length > 0
      ? h('div', { key: 'timeline' }, timeline(shown, deployment.commit, ctx.state.now))
      : h('p', { class: 'quiet', key: 'none' }, 'No commit here touched that.'),
  ];
}

export function historyView(ctx) {
  return h('div', { class: 'page history-page', key: 'page' },
    developerTabs('history'),
    pageHead({
      title: 'History',
      lede: h('span', null, 'Every change to the project, newest first, as ', mono('git log'), ' had it when this console was deployed.'),
    }),
    historyBody(ctx));
}
