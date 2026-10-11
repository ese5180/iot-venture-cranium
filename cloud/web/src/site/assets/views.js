/**
 * Everything the console draws.
 *
 * A view is a function from the console's state to a description of the page: a tree
 * of plain objects made with h(). render() turns such a tree into DOM the first time
 * and afterwards changes only what differs, so a page that refreshes every few seconds
 * keeps its focus, its scroll position and its announcements to screen readers.
 *
 * render() is the only code here that writes to the document, and it can only create
 * elements, set attributes and set text. There is no way to hand it markup: a string
 * always becomes a text node, whatever it contains. Inline styles and inline event
 * handlers are refused outright, because the page's content security policy forbids
 * them; the one style API in use is setProperty for custom properties.
 *
 * No dependencies.
 */

import {
  SESSION_WARNING_S, alreadyRuns, busyBoards, canRetryUpload, compareVersions, dayLabel, deploymentHref,
  describeAudit, describeCounts, describeDeployment, describeExecution, describeStatus, describeUpdate,
  deviceHref, duration, exactBytes, exactTime, fileSize, isRefusal, isUnderWay, isUnfinished, nameOf,
  parseVersion, plural, reviewImage, revocationState, sentence, shortAccount, signalQuality, singleLine,
  timeAgo, versionOfDeployment,
} from './core.js';

// Drawing.

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden', 'indeterminate']);
const HANDLERS = Symbol('handlers');
const TREE = Symbol('tree');
const NO_PROPS = Object.freeze({});

/**
 * Describe an element. Children may be descriptions, strings, numbers, arrays of
 * those, or null/false for "nothing here".
 */
export function h(tag, props, ...children) {
  const node = { tag, props: props ?? NO_PROPS, children: [], key: props?.key ?? null, el: null };
  collect(node.children, children);
  return node;
}

function collect(into, items) {
  for (const item of items) {
    if (item === null || item === undefined || item === false || item === true) continue;
    if (Array.isArray(item)) collect(into, item);
    else if (typeof item === 'object') into.push(item);
    else into.push({ tag: null, text: String(item), children: null, key: null, el: null });
  }
}

function dispatch(event) {
  const handler = event.currentTarget[HANDLERS]?.[event.type];
  if (handler) handler(event);
}

function setProp(el, name, value, before) {
  if (name === 'key' || name === 'ref') return;
  if (name === 'vars') {
    for (const property of Object.keys(before ?? NO_PROPS)) {
      if (!value || !(property in value)) el.style.removeProperty(property);
    }
    for (const [property, text] of Object.entries(value ?? NO_PROPS)) {
      if (!property.startsWith('--')) throw new Error('Only custom properties may be set from script');
      el.style.setProperty(property, String(text));
    }
    return;
  }
  if (/^on[A-Z]/.test(name)) {
    const type = name.slice(2).toLowerCase();
    const handlers = el[HANDLERS] ?? (el[HANDLERS] = {});
    if (!(type in handlers)) el.addEventListener(type, dispatch);
    handlers[type] = typeof value === 'function' ? value : null;
    return;
  }
  if (name === 'style' || name.startsWith('on') || name === 'srcdoc') {
    throw new Error(`The attribute ${name} is not allowed`);
  }
  if (PROPERTIES.has(name)) {
    const next = name === 'value' ? String(value ?? '') : Boolean(value);
    if (el[name] !== next) el[name] = next;
    return;
  }
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

function setProps(el, before, after) {
  for (const name of Object.keys(before)) {
    if (!(name in after)) setProp(el, name, null, before[name]);
  }
  for (const name of Object.keys(after)) {
    if (before[name] !== after[name] || PROPERTIES.has(name)) setProp(el, name, after[name], before[name]);
  }
}

let created = [];

function create(node, svg) {
  if (node.tag === null) {
    node.el = document.createTextNode('');
    node.el.textContent = node.text;
    return node.el;
  }
  const inSvg = svg || node.tag === 'svg';
  node.el = inSvg ? document.createElementNS(SVG_NAMESPACE, node.tag) : document.createElement(node.tag);
  setProps(node.el, NO_PROPS, node.props);
  for (const child of node.children) node.el.appendChild(create(child, inSvg));
  if (typeof node.props.ref === 'function') created.push([node.props.ref, node.el]);
  return node.el;
}

function same(a, b) {
  return a.tag === b.tag && a.key === b.key;
}

function update(before, after, svg) {
  after.el = before.el;
  if (after.tag === null) {
    if (before.text !== after.text) after.el.textContent = after.text;
    return;
  }
  const inSvg = svg || after.tag === 'svg';
  setProps(after.el, before.props, after.props);
  updateChildren(after.el, before.children, after.children, inSvg);
}

function updateChildren(parent, before, after, svg) {
  // Children with a key are matched by it, the others in order. A key that turns up
  // twice is matched once; its second bearer is treated like a child without one.
  const keyed = new Map();
  const loose = [];
  for (const child of before) {
    if (child.key === null || keyed.has(child.key)) loose.push(child);
    else keyed.set(child.key, child);
  }

  const gone = [];
  let nextLoose = 0;
  for (const child of after) {
    let match = null;
    if (child.key !== null) {
      match = keyed.get(child.key) ?? null;
      keyed.delete(child.key);
    } else if (nextLoose < loose.length) {
      match = loose[nextLoose];
      nextLoose += 1;
    }
    if (match && same(match, child)) {
      update(match, child, svg);
    } else {
      create(child, svg);
      if (match) gone.push(match);
    }
  }
  for (const child of keyed.values()) gone.push(child);
  for (let index = nextLoose; index < loose.length; index += 1) gone.push(loose[index]);
  for (const child of gone) parent.removeChild(child.el);

  let position = parent.firstChild;
  for (const child of after) {
    if (child.el === position) position = position.nextSibling;
    else parent.insertBefore(child.el, position);
  }
}

/** Draw a description into a container, or bring what is there up to date. */
export function render(container, node) {
  const before = container[TREE];
  if (before && same(before, node)) update(before, node, false);
  else container.replaceChildren(create(node, false));
  container[TREE] = node;

  const ready = created;
  created = [];
  for (const [ref, el] of ready) ref(el);
}

// Icons: drawn here, stroked in the current text colour.

const RING = ['circle', { cx: 12, cy: 12, r: 9 }];
const ICONS = {
  check: [['polyline', { points: '5 12.5 10 17.5 19 7' }]],
  'check-circle': [RING, ['polyline', { points: '8 12.4 11 15.4 16.2 9.4' }]],
  x: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  'x-circle': [RING, ['path', { d: 'M9 9l6 6M15 9l-6 6' }]],
  clock: [RING, ['polyline', { points: '12 7.5 12 12 15 14' }]],
  alert: [['path', { d: 'M12 4.5l8.5 14.5h-17z' }], ['path', { d: 'M12 10.5v3.5M12 16.6v.1' }]],
  ban: [RING, ['path', { d: 'M5.7 5.7l12.6 12.6' }]],
  'minus-circle': [RING, ['path', { d: 'M8 12h8' }]],
  minus: [['path', { d: 'M6 12h12' }]],
  undo: [['polyline', { points: '8 5 4 9 8 13' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H10' }]],
  download: [['path', { d: 'M12 4v11.5M5 20h14' }], ['polyline', { points: '7 11 12 16 17 11' }]],
  upload: [['path', { d: 'M12 16V4.5M5 20h14' }], ['polyline', { points: '7 9 12 4 17 9' }]],
  restart: [
    ['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }],
    ['polyline', { points: '19.5 3.5 19.5 7.5 15.5 7.5' }],
  ],
  shield: [
    ['path', { d: 'M12 3.5l7 2.6v5.4c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6.1z' }],
    ['polyline', { points: '9 12.2 11.2 14.4 15.2 9.9' }],
  ],
  pulse: [['polyline', { points: '3 12 7.5 12 10 6 14 18 16.5 12 21 12' }]],
  press: [RING, ['circle', { cx: 12, cy: 12, r: 3.5 }]],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 }]],
  hourglass: [
    ['path', { d: 'M7 4h10M7 20h10M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8' }],
  ],
  offline: [['path', { d: 'M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1M5 4l14 16' }]],
  online: [['path', { d: 'M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1' }]],
  chip: [
    ['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }],
    ['path', { d: 'M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3' }],
  ],
  package: [
    ['path', { d: 'M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM4.5 7.7l7.5 4.3 7.5-4.3M12 12v8.5' }],
  ],
  send: [['path', { d: 'M20.5 3.5L10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4z' }]],
  list: [['path', { d: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1' }]],
  user: [['circle', { cx: 12, cy: 8.5, r: 3.5 }], ['path', { d: 'M5 20a7 7 0 0 1 14 0' }]],
  copy: [
    ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }],
  ],
  'arrow-right': [['path', { d: 'M5 12h14' }], ['polyline', { points: '13 6 19 12 13 18' }]],
  'arrow-left': [['path', { d: 'M19 12H5' }], ['polyline', { points: '11 6 5 12 11 18' }]],
  key: [['circle', { cx: 8, cy: 15.5, r: 4 }], ['path', { d: 'M11 12.6l8.5-8.6M15.5 8l3 3' }]],
  lock: [
    ['rect', { x: 5.5, y: 11, width: 13, height: 9, rx: 2 }],
    ['path', { d: 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3' }],
  ],
  plus: [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
  file: [['path', { d: 'M7 3.5h7l4 4v13H7zM14 3.5v4h4' }]],
  'sign-out': [
    ['path', { d: 'M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10M9.5 12H20' }],
    ['polyline', { points: '16 8 20 12 16 16' }],
  ],
};

/** A decorative icon. Its meaning is always also given in words next to it. */
export function icon(name, className = '') {
  const shapes = ICONS[name] ?? ICONS.minus;
  return h('svg', {
    class: `icon ${className}`.trim(),
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  }, shapes.map(([tag, attributes]) => h(tag, attributes)));
}

// Small pieces used by every view.

function badge(tone, iconName, label, title) {
  return h('span', { class: `badge is-${tone}`, title }, icon(iconName), h('span', null, label));
}

function mono(content, className = '') {
  return h('span', { class: `mono ${className}`.trim() }, content);
}

/** A link when there is somewhere valid to go, plain text otherwise. */
function linkTo(href, props, ...children) {
  return href ? h('a', { ...props, href }, children) : h('span', props, children);
}

/** A time, told relative to now, with the exact time as its tooltip. */
function when(iso, now, prefix = '') {
  if (!iso) return null;
  return h('time', { datetime: iso, title: exactTime(iso) }, `${prefix}${timeAgo(iso, now)}`);
}

function whenLoaded(resource, now) {
  return when(new Date(resource.loadedAt).toISOString(), now);
}

/**
 * A person, named by the address their account showed at the time. The address is
 * display data that its owner can change; the account id is the identity, and is the
 * tooltip of the name wherever a person is named.
 */
function who(person) {
  return h('span', { class: 'who', title: person?.sub ? `Account ${person.sub}` : null }, nameOf(person));
}

function signed(number) {
  return number < 0 ? `−${Math.abs(number)}` : String(number);
}

function button(className, onClick, ...children) {
  return h('button', { type: 'button', class: `btn ${className}`.trim(), onClick }, children);
}

function meter(percent, label) {
  return h('div', {
    class: 'meter',
    role: 'progressbar',
    'aria-label': label,
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(percent),
    vars: { '--progress': `${percent}%` },
  }, h('span', { class: 'meter-fill' }));
}

function facts(rows) {
  return h('dl', { class: 'facts' }, rows.filter(Boolean).map(([term, ...value]) =>
    h('div', { class: 'fact', key: term }, h('dt', null, term), h('dd', null, value))));
}

function factNote(text) {
  return h('span', { class: 'fact-note' }, text);
}

/** Nothing here yet: what that means, and what to do next. `action` is a link drawn as a button. */
function empty({ iconName, title, text, command, action }) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty-icon' }, icon(iconName)),
    h('p', { class: 'empty-title' }, title),
    text ? h('p', { class: 'empty-text' }, text) : null,
    command ? h('code', { class: 'code' }, command) : null,
    action
      ? h('a', { class: 'btn', href: action.href, onClick: action.onClick ?? null }, action.label)
      : null);
}

const NO_BOARDS = {
  iconName: 'chip',
  title: 'No boards are registered yet.',
  text: 'Provision one with',
  command: 'python3 tools/provision_device.py',
};

const NOTICE_ROLES = { bad: 'alert', warn: 'status' };

/**
 * A boxed message. `said` is announced to a screen reader: at once for bad news, in
 * turn for a warning. `more` is shown with it and not announced. Whatever changes
 * while the message stands, such as a time or a request id, goes there, or it would be
 * read out again at every change.
 */
function notice(tone, iconName, said, { more = null, action = null } = {}) {
  return h('div', { class: `notice is-${tone}` },
    icon(iconName),
    h('div', { class: 'notice-text' },
      h('span', { class: 'notice-said', role: NOTICE_ROLES[tone] ?? null }, said), more),
    action);
}

/** How to refer to a failed request: the server's code for it and the request id. */
function problemRef(error) {
  const coded = error.status >= 400 && error.code && error.code !== 'gateway' && error.code !== 'http';
  if (!coded && !error.requestId) return null;
  return h('span', { class: 'notice-ref dotted' },
    coded ? h('span', null, 'Code ', mono(error.code)) : null,
    error.requestId ? h('span', null, 'Request ', mono(error.requestId)) : null);
}

/**
 * A failed action: what did not happen, then the server's own words. Only a refusal
 * (a 4xx reply) says for certain that nothing was done; after anything else the
 * request may have been carried out all the same, and the notice says so.
 */
function failure(refusal, error, extra) {
  const lead = isRefusal(error) ? refusal : 'It is not certain whether this went through.';
  return notice('bad', 'x-circle', [h('strong', null, lead, ' '), sentence(error.message)],
    { more: [extra ?? null, problemRef(error)] });
}

function loadProblem(resource, what, ctx) {
  if (!resource.error) return null;
  const stale = resource.value !== null;
  return h('div', { key: `problem-${what}`, class: 'page-notice' },
    notice('bad', 'alert', [
      h('strong', null, stale ? `Could not refresh ${what}. ` : `Could not load ${what}. `),
      sentence(resource.error.message),
    ], {
      // The age changes with the clock and the request id with every retry.
      more: [
        stale ? [' Showing what was loaded ', whenLoaded(resource, ctx.state.now), '.'] : null,
        problemRef(resource.error),
      ],
      action: button('is-small', ctx.actions.refresh, 'Try again'),
    }));
}

function loading(what) {
  return h('p', { class: 'loading', key: 'loading' }, `Loading ${what}…`);
}

/** What a card shows while its data is on the way; nothing once loading has failed. */
function pending(resource, what) {
  return resource.error ? null : loading(what);
}

function copyButton(value, label, ctx) {
  return h('button', {
    type: 'button',
    class: 'btn is-quiet is-icon',
    title: `Copy ${label}`,
    'aria-label': `Copy ${label}`,
    onClick: () => ctx.actions.copy(value, label),
  }, icon('copy'));
}

/** How fresh the page is: live while it is being polled, otherwise when it was loaded. */
function freshness(resource, ctx) {
  const { interval, now } = ctx.state;
  const live = interval > 0 && interval <= 10000;
  return h('div', { class: 'freshness' },
    live
      ? h('span', {
        class: 'freshness-live',
        title: `Refreshing by itself every ${interval / 1000} s. Paused while this tab is in the background.`,
      },
      h('span', { class: 'live-dot' }),
      // The rate is left out where the row is narrow; the tooltip keeps it.
      h('span', null, 'Live', h('span', { class: 'freshness-rate' }, ` · every ${interval / 1000} s`)))
      : resource.loadedAt
        ? h('span', { class: 'freshness-age' }, 'Updated ', whenLoaded(resource, now))
        : null,
    h('button', {
      type: 'button',
      class: 'btn is-quiet is-icon',
      title: 'Refresh now',
      'aria-label': 'Refresh now',
      onClick: ctx.actions.refresh,
    }, icon('restart', resource.loading ? 'is-spinning' : '')));
}

function pageHead({ title, lede, meta, back, tools, eyebrow }) {
  return h('header', { class: 'page-head' },
    back ? h('a', { class: 'back', href: back.href }, icon('arrow-left'), back.label) : null,
    h('div', { class: 'page-head-row' },
      h('div', { class: 'page-head-text' },
        // The eyebrow says what kind of thing the title names, so it is part of the
        // heading: a list of headings reads "Deployment of 1.2.3+5", not "1.2.3+5".
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' },
          eyebrow ? h('span', { class: 'eyebrow' }, eyebrow, ' ') : null, title),
        lede ? h('p', { class: 'page-lede' }, lede) : null,
        meta ? h('div', { class: 'page-meta dotted' }, meta) : null),
      tools ? h('div', { class: 'page-tools' }, tools) : null));
}

function card({ key, title, more, className = '' }, ...body) {
  return h('section', { key, class: `card ${className}`.trim() },
    title || more
      ? h('header', { class: 'card-head' },
        title ? h('h2', { class: 'eyebrow' }, title) : null,
        more ? h('a', { class: 'card-more', href: more.href }, more.label, icon('arrow-right')) : null)
      : null,
    body);
}

function presence(device, now) {
  if (device.online) {
    const reported = device.lastSeen ? `Last report ${timeAgo(device.lastSeen, now)}` : null;
    return badge('good', 'online', 'Online', reported);
  }
  if (!device.lastSeen) return badge('idle', 'minus-circle', 'Never connected');
  return badge('idle', 'offline', 'Offline', `Last seen ${exactTime(device.lastSeen)}`);
}

/** An icon and a few words for a state; `description` comes from core.js. */
function statusLine(description, extra) {
  return h('span', { class: `status is-${description.tone}` },
    icon(description.icon),
    h('span', null, description.title ?? description.label),
    extra ?? null);
}

const REVOCATION_OPEN = 'The server has not recorded that the image is refused and that every open ' +
  'deployment of this release is cancelled.';

/** The badges of a release: its status, and a warning while its revocation is not finished. */
function releaseBadge(release) {
  if (release.status === 'active') return badge('good', 'check-circle', 'Active');
  return [
    badge('bad', 'ban', 'Revoked'),
    revocationState(release) === 'incomplete'
      ? badge('warn', 'alert', 'Revocation incomplete', REVOCATION_OPEN)
      : null,
  ];
}

function signalBars(quality) {
  return h('svg', { class: 'signal', viewBox: '0 0 20 16', 'aria-hidden': 'true', focusable: 'false' },
    [0, 1, 2, 3].map((index) => h('rect', {
      class: index < quality.bars ? 'is-on' : null,
      x: String(index * 5.5),
      y: String(12 - index * 4),
      width: '3.5',
      height: String(4 + index * 4),
      rx: '1',
    })));
}

// The step indicator for one board's update.

const STEP_STATES = {
  done: { icon: 'check', label: 'done' },
  current: { icon: null, label: 'in progress' },
  failed: { icon: 'x', label: 'stopped here' },
  skipped: { icon: null, label: 'not reached' },
  upcoming: { icon: null, label: 'not started' },
};
const DOWNLOAD_STEP = 2;

function stepList(description) {
  return h('ol', { class: 'steps', 'aria-label': 'Steps of the update' },
    description.steps.map((step, index) => {
      const state = STEP_STATES[step.state];
      const current = step.state === 'current';
      const downloading = current && index === DOWNLOAD_STEP && description.progress !== null;
      return h('li', {
        // By position: what a step is called changes with its state.
        key: String(index),
        class: `step is-${step.state} ${downloading ? 'has-progress' : ''}`.trim(),
        'aria-current': current ? 'step' : null,
        // The rail from this step to the next fills as the image comes in.
        vars: downloading ? { '--progress': `${description.progress}%` } : null,
      },
      h('span', { class: 'step-mark' }, state.icon ? icon(state.icon) : null),
      h('span', { class: 'step-label' }, step.label, downloading ? ` ${description.progress}%` : null),
      h('span', { class: 'sr-only' }, `: ${state.label}`));
    }));
}

// Sign-in and other moments when there is no console to show.

/** A single message in the middle of the page, with at most one thing to do. */
export function gateView({ iconName = 'lock', title, text, detail, code, action }) {
  return h('div', { class: 'gate' },
    h('span', { class: 'gate-icon' }, icon(iconName)),
    h('h1', { class: 'gate-title', id: 'page-title', tabindex: '-1' }, title),
    text ? h('p', { class: 'gate-text' }, text) : null,
    detail ? h('p', { class: 'gate-text' }, detail, code ? [' ', mono(code)] : null) : null,
    action ? button(action.quiet ? '' : 'is-primary', action.run, action.label) : null);
}

// The masthead: sections and who is signed in.

const SECTIONS = [
  ['overview', 'Overview'],
  ['devices', 'Devices'],
  ['firmware', 'Firmware'],
  ['deployments', 'Deployments'],
  ['activity', 'Activity'],
];
const SECTION_OF = { device: 'devices', deployment: 'deployments' };

export function navView(ctx) {
  const current = SECTION_OF[ctx.state.route.view] ?? ctx.state.route.view;
  return h('ul', { class: 'nav-list' }, SECTIONS.map(([view, label]) =>
    h('li', { key: view }, h('a', {
      class: 'nav-link',
      href: `#/${view}`,
      'aria-current': view === current ? 'page' : null,
    }, label))));
}

export function accountView(ctx) {
  const { me, sessionLeft } = ctx.state;
  const left = Math.max(0, sessionLeft);
  const ends = new Date(Date.now() + left * 1000);
  const role = me.canWrite ? 'Release manager' : 'Viewer';
  // The account id is what the activity log files this person's actions under.
  const identity = [me.email, me.sub ? `Account ${me.sub}` : ''].filter(Boolean).join(' · ');
  return h('div', { class: 'account-box' },
    h('div', { class: 'account-who' },
      h('span', { class: 'account-email', title: identity || null }, me.email || 'Signed in'),
      h('span', { class: 'account-meta' },
        h('span', { class: 'account-role' }, icon(me.canWrite ? 'key' : 'user', 'is-small'), role),
        h('span', {
          class: 'account-session',
          title: `You will be asked to sign in again at ${ends.toLocaleTimeString()}.`,
        }, `Session ends in ${duration(left)}`))),
    button('is-small', ctx.actions.signOut, icon('sign-out'), 'Sign out'));
}

// Overview.

/** One entry of the activity log. The short form is for the overview. */
function activityLine(entry, ctx, compact) {
  const description = describeAudit(entry);
  const { actor } = entry;
  const name = nameOf(actor);
  const account = actor?.sub ? `Account ${actor.sub}` : null;
  const outcome = description.outcome
    ? [' ', badge(description.outcome.tone, description.outcome.icon, description.outcome.label)]
    : null;
  return h('li', { key: `${entry.at}-${entry.requestId}`, class: 'log-line' },
    h('span', { class: 'log-icon' }, icon(description.icon)),
    h('div', { class: 'log-body' },
      h('p', { class: 'log-what' },
        // The short form leaves out the domain of the address; the tooltip has all of it.
        h('span', {
          class: 'log-actor',
          title: compact ? [actor?.email, account].filter(Boolean).join(' · ') || null : account,
        }, compact && actor?.email ? name.split('@')[0] : name),
        ` ${description.verb} `,
        description.label
          ? linkTo(description.href, { class: 'mono log-target' }, description.label)
          : null,
        outcome),
      compact
        ? null
        : h('p', { class: 'log-detail dotted' },
          description.facts.map((fact) => h('span', { key: `fact-${fact.key}` },
            fact.phrase ? `${fact.label} ` : `${fact.label}: `,
            fact.code ? mono(fact.value) : fact.value)),
          // Two accounts can show the same address, or one that looks the same. The id tells them apart.
          actor?.sub
            ? h('span', { key: 'account', class: 'log-ref', title: account },
              'Account ', mono(shortAccount(actor.sub)))
            : null,
          entry.requestId
            ? h('span', { key: 'request', class: 'log-ref' }, 'Request ', mono(entry.requestId))
            : null)),
    h('span', { class: 'log-when' }, when(entry.at, ctx.state.now)));
}

/** One board of a deployment that is under way, as a line on the overview. */
function boardLine(execution, now, known) {
  const description = describeExecution(execution);
  const lastSeen = known?.lastSeen ?? null;
  const offline = execution.phase === 'waiting_for_device' && !execution.online;
  return h('li', { key: execution.thing, class: 'board-run' },
    linkTo(deviceHref(execution.thing), { class: 'mono board-run-name' }, execution.thing),
    h('div', { class: 'board-run-state' },
      statusLine(description),
      description.progress !== null
        ? meter(description.progress, `Download on ${execution.thing}`)
        : h('span', { class: 'board-run-note' }, description.brief,
          offline && lastSeen ? [' Last seen ', when(lastSeen, now), '.'] : null)));
}

function startedBy(deployment, now) {
  return [
    'Started ',
    when(deployment.createdAt, now),
    deployment.createdBy ? [' by ', who(deployment.createdBy)] : null,
  ];
}

/**
 * The first steps with a new console, ticked off as they are done. A step that is done
 * keeps its title only, and the first one that is not is marked as the next thing to do.
 */
function gettingStarted(ctx, have) {
  const { canWrite } = ctx.state.me;
  const done = [have.boards, have.releases, have.deployments];
  const next = done.indexOf(false);
  const step = (index, title, ...text) => {
    const state = done[index] ? 'is-done' : index === next ? 'is-next' : '';
    return h('li', {
      key: title,
      class: `guide-step ${state}`.trim(),
      'aria-current': index === next ? 'step' : null,
    },
    h('span', { class: 'guide-mark' }, done[index] ? icon('check') : null),
    h('div', null,
      h('p', { class: 'guide-title' },
        title, done[index] ? h('span', { class: 'sr-only' }, ' (done)') : null),
      done[index] ? null : h('p', { class: 'guide-text' }, text)));
  };
  return card({ key: 'guide', title: 'Getting started', className: 'guide' },
    h('ol', { class: 'guide-steps' },
      step(0, 'Register a board',
        'Each board gets its own certificate and name. With the board connected over USB, run ',
        h('code', { class: 'code' }, 'python3 tools/provision_device.py')),
      canWrite
        ? step(1, 'Upload a signed image',
          'Drop the build’s zephyr.signed.bin on the ', h('a', { href: '#/firmware' }, 'Firmware'),
          ' page. The server checks its signature before it is stored.')
        : step(1, 'Upload a signed image',
          'A release manager uploads the build’s zephyr.signed.bin. ',
          'The server checks its signature before it is stored.'),
      canWrite
        ? step(2, 'Deploy it',
          'Start a deployment on the ', h('a', { href: '#/deployments' }, 'Deployments'),
          ' page, then press Button 1 on the board to install.')
        : step(2, 'Deploy it',
          'A release manager offers the release to boards; pressing Button 1 on a board installs it.')));
}

function boardsCard(ctx, devices) {
  const { state } = ctx;
  const online = (devices ?? []).filter((device) => device.online).length;
  let body;
  if (devices === null) {
    body = pending(state.devices, 'boards');
  } else if (devices.length === 0) {
    body = empty(NO_BOARDS);
  } else {
    body = [
      h('p', { class: 'figure', key: 'figure' },
        h('span', { class: 'figure-value' }, String(online)),
        h('span', { class: 'figure-unit' }, ` of ${plural(devices.length, 'board')} online`)),
      h('ul', { class: 'board-list', key: 'list' }, devices.map((device) =>
        h('li', { key: device.thing, class: 'board-line' },
          h('span', { class: `presence-dot ${device.online ? 'is-on' : ''}`.trim() }),
          linkTo(deviceHref(device.thing), { class: 'mono' }, device.thing),
          h('span', { class: 'board-line-note' },
            device.online
              ? 'Online'
              : device.lastSeen ? when(device.lastSeen, state.now, 'Seen ') : 'Never connected')))),
    ];
  }
  return card({ key: 'boards', title: 'Boards', more: { href: '#/devices', label: 'All devices' } }, body);
}

function fleetCard(ctx, devices, newest) {
  const groups = new Map();
  for (const device of devices ?? []) {
    const version = device.fw?.version ?? '';
    groups.set(version, (groups.get(version) ?? []).concat(device));
  }
  // Newest first; boards that have not said what they run come last.
  const versions = [...groups.keys()].sort((a, b) => {
    if (a === '' || b === '') return a === '' ? 1 : -1;
    return compareVersions(parseVersion(b), parseVersion(a));
  });

  let body;
  if (devices === null) {
    body = pending(ctx.state.devices, 'versions');
  } else if (versions.length === 0) {
    body = h('p', { class: 'quiet' }, 'Versions appear here once a board has reported.');
  } else {
    body = h('ul', { class: 'fleet-list' }, versions.map((version) => {
      const members = groups.get(version);
      const onTrial = members.filter((device) => device.fw && !device.fw.confirmed).length;
      return h('li', { key: version || 'none', class: 'fleet-line' },
        version
          ? mono(version, 'fleet-version')
          : h('span', { class: 'fleet-version quiet' }, 'Not reported'),
        h('span', { class: 'pips', 'aria-hidden': 'true' },
          members.map((device) => h('span', { key: device.thing, class: 'pip' }))),
        h('span', { class: 'fleet-count' }, plural(members.length, 'board')),
        version && newest?.version === version ? h('span', { class: 'tag' }, 'Newest release') : null,
        onTrial > 0 ? h('span', { class: 'tag is-warn' }, `${onTrial} on trial`) : null);
    }));
  }
  return card({
    key: 'fleet',
    title: 'Firmware in the fleet',
    more: { href: '#/devices', label: 'Devices' },
  }, body);
}

/**
 * The newest release, in the sense the fleet card uses the words: the newest one that
 * can be deployed. An upload that is newer still but revoked is mentioned below it.
 * Only when nothing can be deployed is the newest upload shown, as revoked.
 */
function releaseCard(ctx, newest) {
  const { state } = ctx;
  const firmware = state.firmware.value;
  const latest = firmware?.releases[0] ?? null;
  const shown = newest ?? latest;
  let body;
  if (!firmware) {
    body = pending(state.firmware, 'releases');
  } else if (!shown) {
    body = h('p', { class: 'quiet' }, 'No firmware has been uploaded yet.');
  } else {
    let note = null;
    if (!newest) {
      note = 'No release can be deployed.';
    } else if (latest !== newest) {
      note = ['A newer upload, ', mono(latest.version), ', was revoked',
        latest.revoked?.at ? [' ', when(latest.revoked.at, state.now)] : null, '.'];
    }
    body = [
      h('p', { class: 'release-figure', key: 'version' },
        mono(shown.version), releaseBadge(shown)),
      h('p', { class: 'card-note', key: 'meta' },
        'Uploaded ', when(shown.uploadedAt, state.now), ' by ', who(shown.uploadedBy)),
      h('p', { class: 'card-note', key: 'size' },
        fileSize(shown.size), ' · SHA-256 ', mono(`${shown.sha256.slice(0, 12)}…`)),
      note ? h('p', { class: 'card-note', key: 'note' }, note) : null,
    ];
  }
  return card({
    key: 'release',
    title: 'Newest release',
    more: { href: '#/firmware', label: 'Firmware' },
  }, body);
}

function updatesCard(ctx, devices) {
  const { state } = ctx;
  const { now } = state;
  const deployments = state.deployments.value;
  const byThing = new Map((devices ?? []).map((device) => [device.thing, device]));
  // Decided by the boards, not by the status of the job: a cancelled deployment can
  // still have a board that is installing.
  const active = (deployments ?? []).filter(isUnderWay);
  const lastDone = (deployments ?? []).find((deployment) => !isUnderWay(deployment)) ?? null;

  let body;
  if (deployments === null) {
    body = pending(state.deployments, 'deployments');
  } else if (active.length === 0) {
    // The tick is for updates that have been through. Before the first deployment
    // there is nothing to tick off.
    const tone = deployments.length === 0 ? 'idle' : 'good';
    body = h('div', { class: 'calm' },
      h('p', { class: `calm-title is-${tone}` },
        icon(tone === 'idle' ? 'minus-circle' : 'check-circle'), 'No update is in progress.'),
      lastDone
        ? h('p', { class: 'card-note' },
          'Last deployment: ',
          linkTo(deploymentHref(lastDone.id), { class: 'mono' }, lastDone.version ?? lastDone.id),
          `, ${describeDeployment(lastDone).label.toLowerCase()}, `,
          // A cancelled deployment has no end on record: say that the time is its start.
          lastDone.completedAt
            ? when(lastDone.completedAt, now)
            : when(lastDone.createdAt, now, 'started '))
        : h('p', { class: 'card-note' }, 'Deployments appear here while boards are being updated.'));
  } else {
    body = h('ul', { class: 'run-list' }, active.map((deployment) => {
      const detail = state.deploymentDetails.get(deployment.id)?.value ?? null;
      const counted = describeCounts(deployment.counts).map((entry) => `${entry.count} ${entry.label}`);
      return h('li', { key: deployment.id, class: 'run' },
        h('div', { class: 'run-head' },
          linkTo(deploymentHref(deployment.id), { class: 'run-version mono' },
            deployment.version ?? deployment.id),
          h('span', { class: 'card-note' }, startedBy(deployment, now))),
        deployment.status === 'CANCELED'
          ? h('p', { class: 'card-note run-note' },
            'This deployment was cancelled. A board that had already started carries on ',
            'unless it is stopped.')
          : null,
        detail
          ? h('ul', { class: 'board-runs' }, detail.executions.map((execution) =>
            boardLine(execution, now, byThing.get(execution.thing))))
          : h('p', { class: 'card-note' }, counted.join(', ')));
    }));
  }
  return card({
    key: 'updates',
    title: 'Updates in progress',
    more: { href: '#/deployments', label: 'All deployments' },
  }, body);
}

function activityCard(ctx) {
  const { state } = ctx;
  const recent = state.recent.value?.entries ?? null;
  let body;
  if (recent === null) {
    body = pending(state.recent, 'activity');
  } else if (recent.length === 0) {
    body = h('p', { class: 'quiet' },
      'Nothing has been recorded yet. Uploads, deployments, cancellations and revocations will appear here.');
  } else {
    body = h('ul', { class: 'log is-compact' },
      recent.slice(0, 5).map((entry) => activityLine(entry, ctx, true)));
  }
  return card({
    key: 'activity',
    title: 'Recent activity',
    more: { href: '#/activity', label: 'All activity' },
  }, body);
}

/**
 * Releases whose revocation the server has not recorded as finished. Until it has, a
 * board may still be able to download or install the image, so this is said on top of
 * the overview, to everyone.
 */
function openRevocations(ctx, firmware) {
  const open = (firmware?.releases ?? []).filter((release) => revocationState(release) === 'incomplete');
  if (open.length === 0) return null;
  const versions = open.map((release, index) => {
    const joint = index === 0 ? null : index === open.length - 1 ? ' and ' : ', ';
    return [joint, mono(release.version)];
  });
  return h('div', { key: 'revocations', class: 'page-notice' },
    notice('warn', 'alert', [
      h('strong', null, 'Revocation incomplete. '),
      versions, open.length === 1 ? ' is' : ' are',
      ' marked revoked, but the server has not recorded the steps that follow: refusing the image ',
      'and cancelling every open deployment. ',
      ctx.state.me.canWrite
        ? 'Finish revoking on the Firmware page.'
        : 'A release manager can finish revoking on the Firmware page.',
    ], { action: h('a', { class: 'btn is-small', href: '#/firmware' }, 'Firmware', icon('arrow-right')) }));
}

export function overviewView(ctx) {
  const { state } = ctx;
  const devices = state.devices.value?.devices ?? null;
  const firmware = state.firmware.value;
  const deployments = state.deployments.value;
  const newest = firmware?.releases.find((release) => release.status === 'active') ?? null;
  const have = {
    boards: (devices ?? []).length > 0,
    releases: (firmware?.releases ?? []).length > 0,
    deployments: (deployments ?? []).length > 0,
  };
  const loaded = devices !== null && firmware !== null && deployments !== null;
  const started = have.boards && have.releases && have.deployments;
  // A console with nothing in it shows the way in, not five cards that each say
  // "nothing yet". What has been recorded all the same, a refused upload for one, stays.
  const blank = loaded && !have.boards && !have.releases && !have.deployments;
  const recorded = (state.recent.value?.entries ?? []).length > 0;

  let cards = null;
  if (!blank) {
    cards = h('div', { class: 'overview', key: 'grid' },
      h('div', { class: 'overview-main' },
        updatesCard(ctx, devices),
        h('div', { class: 'overview-pair' }, fleetCard(ctx, devices, newest), releaseCard(ctx, newest))),
      h('div', { class: 'overview-side' }, boardsCard(ctx, devices), activityCard(ctx)));
  } else if (recorded) {
    cards = activityCard(ctx);
  }

  return h('div', { class: 'page' },
    pageHead({
      title: 'Overview',
      lede: 'What the fleet runs, and what is being updated right now.',
      tools: freshness(state.devices, ctx),
    }),
    loadProblem(state.devices, 'the boards', ctx),
    loadProblem(state.firmware, 'the releases', ctx),
    loadProblem(state.deployments, 'the deployments', ctx),
    loadProblem(state.recent, 'the activity log', ctx),
    openRevocations(ctx, firmware),
    loaded && !started ? gettingStarted(ctx, have) : null,
    cards);
}

// Devices.

function firmwareFact(device) {
  if (!device.fw) return h('span', { class: 'quiet' }, 'Not reported');
  return [
    mono(device.fw.version, 'fact-strong'),
    device.fw.confirmed
      ? badge('good', 'check', 'Confirmed')
      : badge('warn', 'pulse', 'On trial',
        'Not confirmed yet. The bootloader goes back to the previous firmware if the board ' +
        'restarts before it confirms.'),
  ];
}

function updateFact(device) {
  const update = describeUpdate(device);
  const percent = update.progress !== null
    ? h('span', { class: 'status-value' }, `${update.progress}%`)
    : null;
  return h('div', { class: 'fact-stack' },
    statusLine(update, percent),
    update.progress !== null ? meter(update.progress, `Download on ${device.thing}`) : null,
    update.text ? factNote(update.text) : null,
    update.deployment
      ? linkTo(deploymentHref(update.deployment), { class: 'fact-link' },
        'Open the deployment', icon('arrow-right', 'is-small'))
      : null);
}

function signalFact(device) {
  const quality = signalQuality(device.rssi);
  if (!quality) return h('span', { class: 'quiet' }, 'Not reported');
  return h('span', { class: 'signal-fact' },
    signalBars(quality), `${quality.label} · ${signed(device.rssi)} dBm`);
}

function uptimeFact(device) {
  if (device.uptime === null) return h('span', { class: 'quiet' }, 'Not reported');
  return [duration(device.uptime), device.online ? null : h('span', { class: 'quiet' }, ' when last seen')];
}

function deviceFacts(device) {
  return facts([
    ['Firmware', firmwareFact(device)],
    ['Update', updateFact(device)],
    ['Signal', signalFact(device)],
    ['Uptime', uptimeFact(device)],
  ]);
}

function seenLine(device, now) {
  if (device.online) return ['Reported ', when(device.lastSeen, now)];
  if (device.lastSeen) return ['Last seen ', when(device.lastSeen, now)];
  return 'Has not reported to AWS IoT yet. Power it up and check that it was provisioned.';
}

export function devicesView(ctx) {
  const { state } = ctx;
  const devices = state.devices.value?.devices ?? null;
  let body;
  if (devices === null) {
    body = pending(state.devices, 'boards');
  } else if (devices.length === 0) {
    body = card({ key: 'none' }, empty(NO_BOARDS));
  } else {
    body = h('div', { class: 'device-grid', key: 'grid' }, devices.map((device) =>
      h('article', { key: device.thing, class: 'card device' },
        h('header', { class: 'device-head' },
          h('div', null,
            h('h2', { class: 'device-name' },
              linkTo(deviceHref(device.thing), { class: 'mono cover-link' }, device.thing)),
            h('p', { class: 'device-seen' }, seenLine(device, state.now))),
          presence(device, state.now)),
        deviceFacts(device))));
  }
  return h('div', { class: 'page' },
    pageHead({
      title: 'Devices',
      lede: 'Every board registered to this project, as it last reported.',
      tools: freshness(state.devices, ctx),
    }),
    loadProblem(state.devices, 'the boards', ctx),
    body);
}

const NOT_LOADED = Object.freeze({ value: null, error: null, loading: true, loadedAt: 0 });

function historyRow(execution, now) {
  const version = execution.version ?? versionOfDeployment(execution.deployment);
  return h('li', { key: execution.deployment, class: 'row history-row' },
    h('div', { class: 'row-main' },
      linkTo(deploymentHref(execution.deployment), { class: 'mono row-title cover-link' },
        version ?? execution.deployment),
      h('span', { class: 'row-note' },
        'Offered ', when(execution.queuedAt, now),
        isUnfinished(execution.status) ? null : [' · ended ', when(execution.lastUpdatedAt, now)])),
    statusLine(describeStatus(execution.status)));
}

export function deviceView(ctx) {
  const { state } = ctx;
  const { thing } = state.route;
  const resource = state.deviceDetails.get(thing) ?? NOT_LOADED;
  const detail = resource.value;
  const head = pageHead({
    back: { href: '#/devices', label: 'Devices' },
    eyebrow: 'Board',
    title: mono(thing),
    lede: detail ? seenLine(detail.device, state.now) : null,
    tools: freshness(resource, ctx),
  });
  if (!detail) {
    return h('div', { class: 'page' },
      head, loadProblem(resource, 'this board', ctx), pending(resource, 'the board'));
  }

  const { device, certificates, executions } = detail;
  return h('div', { class: 'page' },
    head,
    loadProblem(resource, 'this board', ctx),
    h('div', { class: 'split', key: 'split' },
      card({ key: 'state', title: 'State', className: 'device' },
        h('div', { class: 'device-presence' }, presence(device, state.now)),
        deviceFacts(device)),
      h('div', { class: 'stack' },
        card({ key: 'certificates', title: 'Certificates' },
          certificates.length === 0
            ? h('p', { class: 'quiet' },
              'No certificate is attached, so this board cannot connect. Run the provisioning tool again.')
            : [
              h('ul', { class: 'plain-list', key: 'list' }, certificates.map((id) =>
                h('li', { key: id }, icon('key', 'is-small'), mono(`${id}…`)))),
              h('p', { class: 'card-note', key: 'note' },
                'The start of each certificate ID. The certificate belongs to this board alone; ',
                'its private key never leaves the board.'),
            ]),
        card({ key: 'history', title: 'Update history' },
          executions.length === 0
            ? h('p', { class: 'quiet' }, 'This board has not been offered an update yet.')
            : h('ul', { class: 'rows' }, executions.map((execution) => historyRow(execution, state.now)))))));
}

// Firmware.

function trustPanel(ctx) {
  const fingerprint = ctx.state.firmware.value?.fingerprint ?? '';
  return h('div', { class: 'trust' },
    h('h2', { class: 'trust-title' }, icon('shield'), 'The server verifies every upload'),
    h('p', null,
      'An image is stored only if its ECDSA P-256 signature checks out against this project’s ',
      'signing key. The board’s bootloader checks the same signature again before it starts the image.'),
    h('p', null,
      'The console holds only the public half of that key. It can check a signature; it can never ',
      'make one, and neither can anyone who signs in here.'),
    fingerprint
      ? h('div', { class: 'fingerprint' },
        h('p', { class: 'eyebrow' }, 'Signing key fingerprint · SHA-256'),
        h('div', { class: 'digest-row' },
          mono(fingerprint, 'digest'), copyButton(fingerprint, 'the key fingerprint', ctx)))
      : null);
}

function dropZone(ctx) {
  const { upload } = ctx.state;
  const slot = ctx.state.firmware.value?.slotSize ?? null;
  return h('label', {
    class: `drop ${upload.over ? 'is-over' : ''}`.trim(),
    onDragenter: ctx.actions.dragOver,
    onDragover: ctx.actions.dragOver,
    onDragleave: ctx.actions.dragLeave,
    onDrop: ctx.actions.dropFile,
  },
  h('input', {
    type: 'file',
    class: 'drop-input',
    accept: '.bin,application/octet-stream',
    onChange(event) {
      const [file] = event.target.files;
      event.target.value = '';
      if (file) ctx.actions.chooseFile(file);
    },
  }),
  h('span', { class: 'drop-icon' }, icon('upload')),
  h('span', { class: 'drop-title' }, 'Drop ', mono('zephyr.signed.bin'), ' here'),
  h('span', { class: 'drop-or' }, 'or ', h('span', { class: 'drop-pick' }, 'choose a file')),
  h('span', { class: 'drop-note' },
    slot ? `A signed MCUboot image, up to ${fileSize(slot)}. ` : 'A signed MCUboot image. ',
    'Nothing is sent until you have checked what the file contains.'));
}

/** Enter in a field neither submits a dialog nor starts a new line in a one-line text. */
function ignoreEnter(event) {
  if (event.key === 'Enter' && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) {
    event.preventDefault();
  }
}

const CHECK_ICONS = { good: 'check-circle', warn: 'alert', bad: 'x-circle', wait: 'clock' };

// What the browser reads from a file says nothing about its signature. The list of
// checks says so itself, at the place where the decision to upload is made.
const SIGNATURE_UNCHECKED = {
  tone: 'wait',
  text: 'Signature: not checked yet. The server checks it against the project key when you upload.',
};

/**
 * Said while a file waits to be sent and the session is about to end: the console does
 * not leave for the sign-in page by itself while a file is in hand, because the file
 * would be gone on the way back.
 */
function sessionEnding(ctx) {
  const left = ctx.state.sessionLeft;
  if (left >= SESSION_WARNING_S) return null;
  const over = left <= 0;
  return h('div', { key: 'session' },
    notice('warn', 'clock',
      h('strong', null, over ? 'Your session has ended. ' : 'Your session is about to end. '),
      {
        more: over
          ? 'Sign in again to upload; the file has to be chosen again afterwards.'
          : [
            `It ends in ${left < 60 ? 'less than a minute' : duration(left)}. Upload now, or sign in `,
            'again first; the file has to be chosen again after signing in.',
          ],
        action: button('is-small', ctx.actions.signInAgain, 'Sign in again'),
      }));
}

function uploadPanel(ctx) {
  const { upload } = ctx.state;
  const { actions } = ctx;

  if (upload.stage === 'idle') return dropZone(ctx);
  if (upload.stage === 'reading') {
    return h('div', { class: 'upload-state', role: 'status' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      h('p', { class: 'quiet' }, 'Reading the file…'));
  }
  if (upload.stage === 'done') {
    const { version } = upload.release;
    return h('div', { class: 'upload-state', role: 'status' },
      h('p', { class: 'upload-title is-good' }, icon('check-circle'), 'Registered as ', mono(version)),
      h('p', null, 'The signature is valid and the image is stored. It can now be offered to boards.'),
      h('div', { class: 'button-row' },
        button('is-primary', () => actions.openDeploy(version), icon('send'), 'Deploy this release'),
        button('', actions.resetUpload, 'Upload another')));
  }

  const review = reviewImage(upload, ctx.state.firmware.value);
  const busy = upload.stage === 'sending' || upload.stage === 'checking';
  const refused = upload.stage === 'refused';
  // A refusal of the file itself is final: sending the same bytes again cannot end
  // differently, so the way on is another file. A request that failed can be repeated.
  const final = refused && !canRetryUpload(upload.error);
  // What a 401 or a 403 refuses is the account, not the file.
  const ofImage = final && upload.error.status !== 401 && upload.error.status !== 403;
  const percent = Math.round((upload.sent ?? 0) * 100);
  const { header } = upload;
  // Once the server has answered, its answer says what there is to say about the signature.
  const checks = review.blocked || refused ? review.notes : [...review.notes, SIGNATURE_UNCHECKED];

  let next = null;
  if (upload.stage === 'sending') {
    // The figure is for the eye. The progress bar carries it for a screen reader,
    // which would otherwise read out every change of this line.
    next = h('div', { class: 'upload-progress', role: 'status' },
      h('p', null, 'Uploading…', h('span', { 'aria-hidden': 'true' }, ` ${percent}%`)),
      meter(percent, 'Upload'));
  } else if (upload.stage === 'checking') {
    next = h('div', { class: 'upload-progress', role: 'status' },
      h('p', null, 'Uploaded. The server is checking the signature…'),
      h('div', { class: 'meter is-busy' }, h('span', { class: 'meter-fill' })));
  } else if (final) {
    next = h('div', { class: 'button-row', key: 'another' },
      button('is-primary', actions.resetUpload, icon('file'), 'Choose another file'));
  } else if (!review.blocked) {
    next = [
      h('label', { class: 'field', key: 'notes' },
        h('span', { class: 'field-label' }, 'Notes ', h('span', { class: 'quiet' }, '(optional)')),
        h('textarea', {
          class: 'input',
          rows: '2',
          maxlength: '500',
          value: upload.notes,
          onKeydown: ignoreEnter,
          onInput: (event) => actions.setUploadNotes(event.target.value),
        }),
        h('span', { class: 'field-hint' }, 'What changed in this build. Shown next to the release.')),
      sessionEnding(ctx),
      h('div', { class: 'button-row', key: 'send' },
        button('is-primary', actions.startUpload,
          icon('upload'), refused ? 'Try again' : 'Upload for verification')),
    ];
  }

  return h('div', { class: 'upload-state' },
    h('div', { class: 'upload-file' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      busy || final ? null : button('is-small', actions.resetUpload, 'Choose another file')),
    header.ok
      ? facts([
        ['Version', mono(header.version, 'fact-strong')],
        ['Size', `${exactBytes(upload.size)} (${fileSize(upload.size)})`],
        ['SHA-256', mono(upload.digest, 'digest')],
        ['Layout',
          `${exactBytes(header.headerSize)} of header, ${exactBytes(header.payloadSize)} of firmware`],
        upload.recordedAs !== upload.name ? ['Recorded as', mono(upload.recordedAs)] : null,
      ])
      : null,
    h('ul', { class: 'checks' }, checks.map((note) =>
      h('li', { key: note.text, class: `check is-${note.tone}` },
        icon(CHECK_ICONS[note.tone]), h('span', null, note.text)))),
    refused
      ? failure(ofImage ? 'The server refused this image.' : 'The image was not stored.', upload.error)
      : null,
    next);
}

/** Who did something, with the account id written out: a tooltip cannot be read on a touch screen. */
function byAccount(person) {
  return factNote(['by ', nameOf(person), person?.sub ? [' · account ', mono(person.sub)] : null]);
}

function releaseDetails(release, fingerprint) {
  const sizes = `${exactBytes(release.size)}: ${exactBytes(release.headerSize)} of header, ` +
    `${exactBytes(release.payloadSize)} of firmware, then the signature`;
  const { revoked } = release;
  return h('details', { class: 'more' },
    h('summary', null, 'Details'),
    facts([
      ['File', mono(release.filename)],
      ['Size', sizes],
      ['File SHA-256', mono(release.sha256, 'digest'), factNote('What a board checks after downloading.')],
      ['Image hash', mono(release.imageHash, 'digest'),
        factNote('What the signature covers and the bootloader verifies.')],
      ['Signed with', mono(release.keyHash, 'digest'),
        factNote(release.keyHash === fingerprint
          ? 'Matches this project’s signing key.'
          : 'Fingerprint of the key that signed it.')],
      ['Load address', mono(`0x${(release.loadAddress ?? 0).toString(16)}`)],
      ['Uploaded', exactTime(release.uploadedAt), byAccount(release.uploadedBy)],
      revoked ? ['Revoked', exactTime(revoked.at), byAccount(revoked.by)] : null,
      revoked?.enforcedAt
        ? ['Enforced', exactTime(revoked.enforcedAt),
          factNote('The image is refused and every open deployment of it was cancelled.')]
        : null,
    ]));
}

function releaseRow(release, ctx) {
  const { now, me } = ctx.state;
  const { actions } = ctx;
  const active = release.status === 'active';
  const revocation = revocationState(release);

  let controls = null;
  if (me.canWrite && active) {
    controls = [
      button('is-small', () => actions.openDeploy(release.version), icon('send'), 'Deploy'),
      button('is-small is-danger-quiet', () => actions.openRevoke(release), icon('ban'), 'Revoke'),
    ];
  } else if (me.canWrite && revocation === 'incomplete') {
    controls = button('is-small is-primary', () => actions.openRevoke(release),
      icon('ban'), 'Finish revoking');
  } else if (me.canWrite && revocation === 'unknown') {
    // A server that keeps no record of whether a revocation was finished: the way to
    // make sure stays open on every revoked release.
    controls = button('is-small', () => actions.openRevoke(release), 'Apply the revocation again');
  }

  return h('li', { key: release.version, class: `row release ${active ? '' : 'is-revoked'}`.trim() },
    h('div', { class: 'release-main' },
      h('div', { class: 'release-title' },
        mono(release.version, 'release-version'),
        releaseBadge(release)),
      release.notes ? h('p', { class: 'release-notes' }, release.notes) : null,
      release.revoked
        ? h('p', { class: 'release-revoked' }, icon('ban', 'is-small'),
          h('span', null,
            'Revoked ', when(release.revoked.at, now), ' by ', who(release.revoked.by), ': ',
            release.revoked.reason))
        : null,
      revocation === 'incomplete'
        ? h('p', { class: 'release-revoked is-open' }, icon('alert', 'is-small'),
          h('span', null,
            REVOCATION_OPEN, ' Until it has, a board may still be able to download or install it. ',
            me.canWrite ? 'Finish revoking to make sure.' : 'A release manager can finish revoking.'))
        : null,
      h('p', { class: 'row-note dotted' },
        h('span', null, fileSize(release.size)),
        h('span', null, 'Uploaded ', when(release.uploadedAt, now), ' by ', who(release.uploadedBy)),
        h('span', { class: 'digest-row' },
          'SHA-256 ', mono(`${release.sha256.slice(0, 16)}…`),
          copyButton(release.sha256, `the SHA-256 of ${release.version}`, ctx))),
      releaseDetails(release, ctx.state.firmware.value.fingerprint)),
    controls ? h('div', { class: 'release-actions' }, controls) : null);
}

export function firmwareView(ctx) {
  const { state } = ctx;
  const firmware = state.firmware.value;
  const { canWrite } = state.me;
  let releases;
  if (!firmware) {
    releases = pending(state.firmware, 'releases');
  } else if (firmware.releases.length === 0) {
    releases = card({ key: 'none' }, empty({
      iconName: 'package',
      title: 'No firmware has been uploaded yet.',
      text: canWrite
        ? 'Build the firmware, then drop build/app/zephyr/zephyr.signed.bin above to register ' +
          'the first release.'
        : 'A release manager can upload the first signed image.',
    }));
  } else {
    releases = card({ key: 'releases', className: 'is-flush' },
      h('ul', { class: 'rows' }, firmware.releases.map((release) => releaseRow(release, ctx))));
  }
  return h('div', { class: 'page' },
    pageHead({
      title: 'Firmware',
      lede: 'Signed images that can be offered to boards. A version, once used, is never reused.',
      tools: freshness(state.firmware, ctx),
    }),
    loadProblem(state.firmware, 'the releases', ctx),
    h('section', { class: `card upload ${canWrite ? '' : 'is-readonly'}`.trim(), key: 'upload' },
      canWrite
        ? h('div', { class: 'upload-main' },
          h('h2', { class: 'eyebrow' }, 'Upload a signed image'), uploadPanel(ctx))
        : null,
      trustPanel(ctx)),
    h('h2', { class: 'section-title', key: 'title' }, 'Releases'),
    releases);
}

// Deployments.

function countList(counts) {
  return h('ul', { class: 'counts' }, describeCounts(counts).map((entry) =>
    h('li', { key: entry.name, class: `status is-${entry.tone}` },
      icon(entry.icon), h('span', null, `${entry.count} ${entry.label}`))));
}

function deploymentRow(deployment, now) {
  const summary = describeDeployment(deployment);
  return h('li', { key: deployment.id, class: 'row deployment-row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'release-title' },
        linkTo(deploymentHref(deployment.id), { class: 'mono release-version cover-link' },
          deployment.version ?? 'Unknown version'),
        badge(summary.tone, summary.icon, summary.label)),
      deployment.note ? h('p', { class: 'release-notes' }, deployment.note) : null,
      h('p', { class: 'row-note dotted' },
        h('span', null, startedBy(deployment, now)),
        h('span', null, plural(deployment.things.length, 'board')))),
    countList(deployment.counts),
    h('span', { class: 'row-chevron' }, icon('arrow-right')));
}

export function deploymentsView(ctx) {
  const { state } = ctx;
  const deployments = state.deployments.value;
  const { canWrite } = state.me;
  const firmware = state.firmware.value;
  const deployable = firmware === null || firmware.releases.some((release) => release.status === 'active');

  let body;
  if (deployments === null) {
    body = pending(state.deployments, 'deployments');
  } else if (deployments.length === 0) {
    let text = 'Choose New deployment to offer a release to one or more boards.';
    if (!canWrite) {
      text = 'When a release manager offers a release to boards, it appears here.';
    } else if (!deployable) {
      text = ['Upload a signed image on the ', h('a', { href: '#/firmware' }, 'Firmware page'),
        ' first; then it can be offered to boards here.'];
    }
    body = card({ key: 'none' }, empty({ iconName: 'send', title: 'No deployments yet.', text }));
  } else {
    body = card({ key: 'list', className: 'is-flush' },
      h('ul', { class: 'rows' }, deployments.map((deployment) => deploymentRow(deployment, state.now))));
  }

  // With no release that can be deployed, the way on is the Firmware page: a button
  // that opens a dialog with nothing to choose from would lead nowhere.
  let start = null;
  if (canWrite && deployable) {
    start = button('is-primary', () => ctx.actions.openDeploy(null), icon('plus'), 'New deployment');
  } else if (canWrite) {
    start = h('a', { class: 'btn is-primary', href: '#/firmware' }, icon('upload'), 'Upload firmware first');
  }
  return h('div', { class: 'page' },
    pageHead({
      title: 'Deployments',
      lede: 'A deployment offers one release to a set of boards. ' +
        'Each board installs it when someone presses its Button 1.',
      tools: [freshness(state.deployments, ctx), start],
    }),
    loadProblem(state.deployments, 'the deployments', ctx),
    body);
}

/** One board's part in a deployment: what it is doing, in words and as steps. */
function executionCard(execution, ctx) {
  const { now } = ctx.state;
  const description = describeExecution(execution);
  const known = (ctx.state.devices.value?.devices ?? []).find((device) => device.thing === execution.thing);
  const finished = !isUnfinished(execution.status);
  const moments = [
    execution.queuedAt ? ['Offered ', when(execution.queuedAt, now)] : null,
    execution.startedAt ? ['Started ', when(execution.startedAt, now)] : null,
    execution.startedAt && execution.lastUpdatedAt
      ? ['Last report ', when(execution.lastUpdatedAt, now)]
      : null,
    execution.status === 'IN_PROGRESS' && execution.secondsLeft !== null
      ? `Times out in ${duration(execution.secondsLeft)}`
      : null,
    // The board's own word on what it runs, when the deployment's record has none.
    finished && !execution.running && known?.fw ? ['Board now reports ', mono(known.fw.version)] : null,
    !execution.online && known?.lastSeen ? ['Board last seen ', when(known.lastSeen, now)] : null,
  ].filter(Boolean);

  return h('article', { key: execution.thing, class: `card execution is-${description.tone}` },
    h('header', { class: 'execution-head' },
      h('h2', { class: 'execution-name' },
        linkTo(deviceHref(execution.thing), { class: 'mono' }, execution.thing)),
      execution.online ? badge('good', 'online', 'Online') : badge('idle', 'offline', 'Offline')),
    h('div', { class: 'execution-state' },
      h('p', { class: `execution-title status is-${description.tone}`, role: 'status' },
        icon(description.icon), h('span', null, description.title)),
      h('p', { class: 'execution-text' }, description.text),
      description.code
        ? h('p', { class: 'execution-code' }, 'The board gave the reason ', mono(description.code))
        : null,
      execution.detail
        ? h('p', { class: 'execution-code' }, 'Board’s note: ', mono(execution.detail))
        : null,
      description.progress !== null
        ? meter(description.progress, `Download on ${execution.thing}`)
        : null),
    stepList(description),
    moments.length > 0
      ? h('p', { class: 'execution-foot dotted' },
        moments.map((moment, index) => h('span', { key: String(index) }, moment)))
      : null);
}

export function deploymentView(ctx) {
  const { state } = ctx;
  const { id } = state.route;
  const resource = state.deploymentDetails.get(id) ?? NOT_LOADED;
  const deployment = resource.value;
  const version = deployment?.version ?? versionOfDeployment(id);
  const summary = deployment ? describeDeployment(deployment) : null;
  const unfinished = deployment
    ? deployment.executions.some((execution) => isUnfinished(execution.status))
    : false;

  const head = pageHead({
    back: { href: '#/deployments', label: 'Deployments' },
    eyebrow: 'Deployment of',
    title: [
      mono(version ?? 'unknown version'),
      summary ? badge(summary.tone, summary.icon, summary.label) : null,
    ],
    lede: deployment?.note || null,
    meta: deployment
      ? [
        h('span', null,
          startedBy(deployment, state.now),
          deployment.completedAt ? [', finished ', when(deployment.completedAt, state.now)] : null),
        h('span', { class: 'digest-row' },
          mono(deployment.id), copyButton(deployment.id, 'the deployment ID', ctx)),
      ]
      : null,
    tools: [
      freshness(resource, ctx),
      state.me.canWrite && unfinished
        ? button('is-danger-quiet', () => ctx.actions.openCancel(deployment),
          icon('stop'), 'Cancel deployment')
        : null,
    ],
  });
  if (!deployment) {
    return h('div', { class: 'page' },
      head, loadProblem(resource, 'this deployment', ctx), pending(resource, 'the deployment'));
  }
  return h('div', { class: 'page' },
    head,
    loadProblem(resource, 'this deployment', ctx),
    deployment.executions.length === 0
      ? card({ key: 'none' },
        h('p', { class: 'quiet' }, 'AWS IoT has not listed any board for this deployment yet.'))
      : h('div', { class: 'executions', key: 'boards' },
        deployment.executions.map((execution) => executionCard(execution, ctx))));
}

// Activity.

export function activityView(ctx) {
  const { state } = ctx;
  const audit = state.audit.value;
  const days = [];
  for (const entry of audit?.entries ?? []) {
    const label = dayLabel(entry.at, state.now);
    if (days.length === 0 || days[days.length - 1].label !== label) days.push({ label, entries: [] });
    days[days.length - 1].entries.push(entry);
  }

  let body;
  if (!audit) {
    body = pending(state.audit, 'activity');
  } else if (audit.entries.length === 0) {
    body = card({ key: 'none' }, empty({
      iconName: 'list',
      title: 'Nothing has been recorded yet.',
      text: 'Uploads, deployments, cancellations and revocations will appear here, ' +
        'including attempts that were refused.',
    }));
  } else {
    body = [
      days.map((day) => h('section', { key: day.label, class: 'log-day' },
        h('h2', { class: 'eyebrow' }, day.label),
        card({ className: 'is-flush' },
          h('ul', { class: 'log' }, day.entries.map((entry) => activityLine(entry, ctx, false)))))),
      h('div', { class: 'log-more', key: 'more' },
        audit.next
          ? h('button', {
            type: 'button',
            class: 'btn',
            disabled: state.audit.loadingMore,
            onClick: ctx.actions.loadMoreActivity,
          }, state.audit.loadingMore ? 'Loading…' : 'Load more')
          : h('p', { class: 'quiet' }, 'That is the whole log.'),
        state.audit.moreError ? failure('Could not load more.', state.audit.moreError) : null),
    ];
  }
  return h('div', { class: 'page' },
    pageHead({
      title: 'Activity',
      lede: 'Every upload, deployment, cancellation and revocation, with who asked for it and ' +
        'how it ended. Entries cannot be changed.',
      tools: freshness(state.audit, ctx),
    }),
    loadProblem(state.audit, 'the activity log', ctx),
    body);
}

// Dialogs. Each is a form inside a <dialog>. It acts when one of its buttons is used,
// never because Enter was pressed in a field, and every button says what it does.

function dialogFrame({ title, body, foot, onSubmit, onClose, busy }) {
  return h('form', {
    class: 'dialog-form',
    method: 'dialog',
    onKeydown: ignoreEnter,
    onSubmit(event) {
      event.preventDefault();
      if (onSubmit) onSubmit();
    },
  },
  h('header', { class: 'dialog-head' },
    h('h2', { class: 'dialog-title', id: 'dialog-title' }, title),
    h('button', {
      type: 'button',
      class: 'btn is-quiet is-icon',
      'aria-label': 'Close',
      disabled: busy,
      onClick: onClose,
    }, icon('x'))),
  h('div', { class: 'dialog-body' }, body),
  h('footer', { class: 'dialog-foot' }, foot));
}

/** A button in the foot of a dialog. `submit` makes it the one the form acts on. */
function dialogButton(options, ...label) {
  const {
    key, className = '', submit = false, disabled = false, autofocus = false, describedBy = null, onClick,
  } = options;
  return h('button', {
    key,
    type: submit ? 'submit' : 'button',
    class: `btn ${className}`.trim(),
    disabled,
    autofocus,
    'aria-describedby': describedBy,
    onClick,
  }, label);
}

const SPACER = () => h('span', { class: 'dialog-spacer', key: 'spacer' });

function consequences(items) {
  return h('ul', { class: 'consequences' },
    items.map((item, index) => h('li', { key: String(index) }, item)));
}

function choice({ key, type, name, checked, disabled = false, onChange }, title, ...notes) {
  return h('label', { key, class: `choice ${disabled ? 'is-disabled' : ''}`.trim() },
    h('input', { type, name, checked, disabled, onChange }),
    h('span', { class: 'choice-body' }, h('span', { class: 'choice-title' }, title), notes));
}

const WIZARD_STEPS = ['Release', 'Boards', 'Review'];

function wizardRelease(release, model, now) {
  return choice({
    key: release.version,
    type: 'radio',
    name: 'release',
    checked: release.version === model.version,
    onChange: () => model.choose(release.version),
  },
  mono(release.version),
  h('span', { class: 'choice-note' },
    fileSize(release.size), ' · uploaded ', when(release.uploadedAt, now), ' by ', who(release.uploadedBy)),
  release.notes ? h('span', { class: 'choice-note' }, release.notes) : null);
}

function wizardBoard(device, model, now) {
  const busy = model.busy.get(device.thing) ?? null;
  const chosen = model.things.has(device.thing);

  // Said for every board, ticked or not: it is what the choice is made by.
  let remark = null;
  if (busy) {
    remark = h('span', { class: 'choice-warning' }, icon('lock', 'is-small'),
      h('span', null,
        'Has an unfinished update', busy.version ? [' to ', mono(busy.version)] : null,
        '. Finish or cancel that deployment first.'));
  } else if (alreadyRuns(device, model.version)) {
    remark = h('span', { class: 'choice-warning' }, icon('alert', 'is-small'),
      h('span', null,
        'Reports that it already runs this version or a newer one, so it will refuse the offer.'));
  } else if (!device.online) {
    remark = h('span', { class: 'choice-hint' }, 'Offline: it will see the offer when it reconnects.');
  }
  return choice({
    key: device.thing,
    type: 'checkbox',
    checked: chosen,
    disabled: Boolean(busy),
    onChange: () => model.toggle(device.thing),
  },
  [mono(device.thing), presence(device, now)],
  h('span', { class: 'choice-note' },
    device.fw ? ['Runs ', mono(device.fw.version)] : 'Has not reported a version',
    device.online || !device.lastSeen ? null : [' · last seen ', when(device.lastSeen, now)]),
  remark);
}

function wizardReview(model, release, chosen, now) {
  const offline = chosen.filter((device) => !device.online).length;
  return [
    facts([
      ['Release', mono(model.version, 'fact-strong'),
        release ? factNote(`${fileSize(release.size)} · SHA-256 ${release.sha256.slice(0, 12)}…`) : null],
      ['Boards', h('ul', { class: 'plain-list' }, chosen.map((device) =>
        h('li', { key: device.thing }, mono(device.thing), presence(device, now))))],
    ]),
    h('label', { class: 'field', key: 'note' },
      h('span', { class: 'field-label' },
        'Note ', h('span', { class: 'quiet' }, '(optional, shown with the deployment)')),
      h('input', {
        class: 'input',
        type: 'text',
        maxlength: '200',
        value: model.note,
        onInput: (event) => model.setNote(event.target.value),
      })),
    h('div', { class: 'callout', key: 'what' },
      h('p', { class: 'callout-title' }, 'What happens when you deploy'),
      consequences([
        ['Each board is offered ', mono(model.version),
          '. Nothing is installed until someone presses Button 1 on that board; Button 2 declines.'],
        offline > 0
          ? `${plural(offline, 'board is', 'boards are')} offline and will see the offer after ` +
            'reconnecting. The offer stays open until it is cancelled.'
          : 'The offer stays open until a board acts on it or the deployment is cancelled.',
        'A board checks the download and its bootloader checks the signature. If the new firmware ' +
          'cannot reconnect, the bootloader puts the previous one back.',
        'These boards cannot be given another deployment until this one has finished or been cancelled.',
      ])),
  ];
}

/**
 * Where the boards are held up that the server named when it refused a deployment. Its
 * own sentence names a single board; with several it only gives their number.
 */
function heldBy(entries) {
  const where = (entry) => {
    const version = versionOfDeployment(entry.deployment);
    return linkTo(deploymentHref(entry.deployment), null,
      version ? ['the deployment of ', mono(version)] : 'another deployment');
  };
  if (entries.length === 1) {
    return h('p', { class: 'notice-more' }, 'That update is ', where(entries[0]), '.');
  }
  return h('ul', { class: 'plain-list notice-more' }, entries.map((entry) =>
    h('li', { key: `${entry.thing} ${entry.deployment}` }, mono(entry.thing), ': ', where(entry))));
}

export function deployDialog(model, ctx) {
  const { now } = ctx.state;
  const releases = model.releases ?? [];
  const devices = model.devices ?? [];
  const release = releases.find((candidate) => candidate.version === model.version) ?? null;
  const chosen = devices.filter((device) => model.things.has(device.thing));
  const free = devices.filter((device) => !model.busy.has(device.thing));
  const ready = !model.loading && !model.loadError;

  let body;
  if (model.loading) {
    body = loading('releases and boards');
  } else if (model.loadError) {
    body = notice('bad', 'alert', [
      h('strong', null, 'Could not load what a deployment needs. '),
      sentence(model.loadError.message),
    ], { more: problemRef(model.loadError), action: button('is-small', model.reload, 'Try again') });
  } else if (model.step === 0 && releases.length === 0) {
    body = empty({
      iconName: 'package',
      title: 'There is no release to deploy.',
      text: 'Upload a signed image on the Firmware page first. Revoked releases cannot be deployed.',
      // The dialog closes by itself when the page changes, but not if this is the Firmware page.
      action: { href: '#/firmware', label: 'Go to Firmware', onClick: model.close },
    });
  } else if (model.step === 0) {
    body = h('fieldset', { class: 'choices' },
      h('legend', null, 'Which release?'),
      releases.map((candidate) => wizardRelease(candidate, model, now)));
  } else if (model.step === 1 && devices.length === 0) {
    body = empty(NO_BOARDS);
  } else if (model.step === 1) {
    body = h('fieldset', { class: 'choices' },
      h('legend', null, 'Which boards get ', mono(model.version), '?'),
      devices.map((device) => wizardBoard(device, model, now)),
      free.length > 1
        ? button('is-small is-quiet', model.toggleAll,
          chosen.length === free.length
            ? 'Clear the selection'
            : `Select all ${free.length} available boards`)
        : null);
  } else {
    body = wizardReview(model, release, chosen, now);
  }

  const refusedBoards = model.error ? busyBoards(model.error) : [];
  const last = model.step === WIZARD_STEPS.length - 1;
  const canGoOn = model.step === 0 ? release !== null : chosen.length > 0;
  // Why "Next" cannot be used yet, said next to it.
  let hint = null;
  if (ready && model.step === 1 && devices.length > 0 && chosen.length === 0) {
    hint = free.length === 0 ? 'Every board has an unfinished update.' : 'Choose at least one board.';
  }
  return dialogFrame({
    title: 'New deployment',
    busy: model.sending,
    onClose: model.close,
    onSubmit: last ? model.submit : (canGoOn ? model.next : null),
    body: [
      h('ol', { class: 'wizard-steps', key: 'steps' }, WIZARD_STEPS.map((label, index) => h('li', {
        key: label,
        class: index === model.step ? 'is-current' : index < model.step ? 'is-done' : null,
        'aria-current': index === model.step ? 'step' : null,
      },
      h('span', { class: 'wizard-number' }, index < model.step ? icon('check') : String(index + 1)),
      label))),
      // Each step takes the focus when it appears, so the keyboard starts at its top.
      h('div', {
        class: 'wizard-body',
        key: `step-${model.step}`,
        tabindex: '-1',
        autofocus: true,
        ref(el) {
          el.focus({ preventScroll: true });
          el.parentElement.scrollTop = 0;
        },
      }, body),
      model.error
        ? h('div', { key: 'error' }, failure('The deployment was not started.', model.error,
          refusedBoards.length > 0 ? heldBy(refusedBoards) : null))
        : null,
    ],
    foot: [
      dialogButton({ key: 'cancel', disabled: model.sending, onClick: model.close }, 'Cancel'),
      SPACER(),
      hint ? h('span', { class: 'dialog-hint', id: 'dialog-hint', key: 'hint' }, hint) : null,
      model.step > 0
        ? dialogButton({ key: 'back', disabled: model.sending, onClick: model.back }, 'Back')
        : null,
      last
        ? dialogButton({
          key: 'go',
          className: 'is-primary',
          submit: true,
          disabled: model.sending || chosen.length === 0,
        }, icon('send'), model.sending ? 'Starting…' : `Deploy to ${plural(chosen.length, 'board')}`)
        : dialogButton({
          key: 'next',
          className: 'is-primary',
          submit: true,
          disabled: model.loading || !canGoOn,
          describedBy: hint ? 'dialog-hint' : null,
        }, 'Next'),
    ],
  });
}

/**
 * The dialog counts from the newest record of the deployment there is, so that it says
 * what is true after somebody else has cancelled, or after the last board has finished.
 */
export function cancelDialog(model) {
  const { deployment } = model;
  const count = (status) => deployment.executions.filter((execution) => execution.status === status).length;
  const waiting = count('QUEUED');
  const started = count('IN_PROGRESS');
  const over = waiting + started === 0;
  // Cancelled before, without force: the offer is withdrawn already, and the one thing
  // left to do is to stop the boards that had started.
  const withdrawn = !over && deployment.status === 'CANCELED';
  const force = model.force || withdrawn;
  const option = (value, title, text, done = false) => choice({
    key: String(value),
    type: 'radio',
    name: 'force',
    checked: force === value,
    disabled: model.sending || done,
    onChange: () => model.setForce(value),
  }, title, h('span', { class: 'choice-note' }, text));

  return dialogFrame({
    title: ['Cancel the deployment of ', mono(deployment.version ?? 'this release'), '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: over ? null : () => model.submit(force),
    body: [
      over
        ? h('p', { key: 'now' },
          h('strong', null, 'Nothing is left to cancel.'),
          ' No board is waiting for this update any more, and none is installing it.')
        : h('p', { key: 'now' },
          'Right now ',
          h('strong', null, plural(waiting, 'board is', 'boards are'), ' waiting'),
          ' and ',
          h('strong', null, plural(started, 'board has', 'boards have'), ' started'),
          '. Boards that already finished are not affected.'),
      over
        ? null
        : h('fieldset', { class: 'choices', key: 'choices' },
          h('legend', null, 'How far should the cancellation go?'),
          withdrawn
            ? option(false, 'Withdraw the offer',
              'Done already: this deployment was cancelled before, so boards that had not started ' +
              'are no longer offered it.', true)
            : option(false, 'Withdraw the offer',
              'Boards that have not started are no longer offered this update. A board that is ' +
              'already downloading or installing carries on and finishes.'),
          option(true, 'Withdraw the offer and stop boards that have started',
            'Forced. A board that is downloading or checking the image stops before installing, because ' +
            'it asks AWS first and finds the update cancelled. A board that is already restarting into ' +
            'the new firmware cannot be stopped; it may still finish, but it can no longer report the ' +
            'result here.')),
      over
        ? null
        : h('p', { class: 'quiet', key: 'eventually' },
          'A cancellation takes a few seconds to reach every board’s record. It cannot be undone; ',
          'to try again, start a new deployment.'),
      model.error ? h('div', { key: 'error' }, failure('Not cancelled.', model.error)) : null,
    ],
    foot: [
      dialogButton({ key: 'keep', autofocus: true, disabled: model.sending, onClick: model.close },
        over ? 'Close' : 'Keep the deployment'),
      SPACER(),
      dialogButton({ key: 'go', className: 'is-danger', submit: true, disabled: model.sending || over },
        model.sending ? 'Cancelling…' : force ? 'Cancel and stop boards' : 'Cancel the deployment'),
    ],
  });
}

const REASON_LIMIT = 200;
// From here on the field says how much room is left, so that a sentence is not cut short unseen.
const REASON_COUNT_FROM = 160;

/** What the two steps after the mark do: the same for a first revocation and for a repeated one. */
function revocationSteps(release) {
  return [
    'The image stops downloading at once, also for a board that is in the middle of downloading it.',
    ['Every unfinished deployment of ', mono(release.version),
      ' is cancelled, including on boards that have already started. They stop before installing.'],
  ];
}

/**
 * Revoking a release that is revoked already: the mark is on record, and the steps
 * after it are repeated. This finishes a revocation that stopped half way.
 */
function revokeAgainDialog(model, ctx) {
  const { release } = model;
  const open = revocationState(release) === 'incomplete';
  const mark = release.revoked;
  let label = open ? 'Finish revoking' : 'Apply again';
  if (model.sending) label = open ? 'Finishing…' : 'Applying…';
  return dialogFrame({
    title: open
      ? ['Finish revoking ', mono(release.version), '?']
      : ['Apply the revocation of ', mono(release.version), ' again?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: model.submit,
    body: [
      h('p', { key: 'lead' }, open
        ? 'This release is marked revoked, but the server has not recorded that the two steps after ' +
          'the mark were completed. Finishing repeats them:'
        : 'This release is revoked. Applying the revocation again repeats the two steps after the ' +
          'mark, in case one of them did not go through:'),
      consequences(revocationSteps(release)),
      mark
        ? h('p', { class: 'release-revoked', key: 'record' }, icon('ban', 'is-small'),
          h('span', null,
            'Revoked ', when(mark.at, ctx.state.now), ' by ', who(mark.by), mark.reason ? ': ' : null,
            mark.reason))
        : null,
      h('p', { class: 'quiet', key: 'same' },
        'That record stays as it is: who revoked the release, when and why.'),
      model.error
        ? h('div', { key: 'error' }, failure(open ? 'Not finished.' : 'Not applied.', model.error))
        : null,
    ],
    foot: [
      dialogButton({ key: 'keep', disabled: model.sending, onClick: model.close }, 'Close'),
      SPACER(),
      dialogButton({
        key: 'go', className: 'is-primary', submit: true, autofocus: true, disabled: model.sending,
      }, icon('ban'), label),
    ],
  });
}

export function revokeDialog(model, ctx) {
  if (model.again) return revokeAgainDialog(model, ctx);
  const { release } = model;
  const reason = singleLine(model.reason);
  const { length } = model.reason;
  return dialogFrame({
    title: ['Revoke ', mono(release.version), '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: reason ? model.submit : null,
    body: [
      h('p', { key: 'lead' },
        'Revoking withdraws a release for good. Use it when an image must not be installed any more.'),
      consequences([
        ...revocationSteps(release),
        'It can never be deployed again, and its version number stays used: the next upload must ' +
          'still be newer.',
        ['Boards that already run ', mono(release.version),
          ' keep running it. To replace it there, upload a newer version and deploy that.'],
        'This cannot be undone.',
      ]),
      h('label', { class: 'field', key: 'reason' },
        h('span', { class: 'field-label' }, 'Reason ', h('span', { class: 'quiet' }, '(required)')),
        h('textarea', {
          class: 'input',
          rows: '2',
          maxlength: String(REASON_LIMIT),
          required: true,
          // Not on a touch screen, where the keyboard would cover the consequences
          // before they have been read; there the dialog opens on "Keep the release".
          autofocus: model.focusReason,
          disabled: model.sending,
          value: model.reason,
          onInput: (event) => model.setReason(event.target.value),
        }),
        h('span', { class: 'field-hint' },
          `Recorded in the activity log and shown next to the release. Up to ${REASON_LIMIT} characters.`,
          length >= REASON_COUNT_FROM
            ? [' ', h('span', { class: `field-count ${length >= REASON_LIMIT ? 'is-full' : ''}`.trim() },
              `${length} / ${REASON_LIMIT}`)]
            : null)),
      model.error ? h('div', { key: 'error' }, failure('Not revoked.', model.error)) : null,
    ],
    foot: [
      dialogButton({
        key: 'keep', autofocus: !model.focusReason, disabled: model.sending, onClick: model.close,
      }, 'Keep the release'),
      SPACER(),
      dialogButton({ key: 'go', className: 'is-danger', submit: true, disabled: model.sending || !reason },
        icon('ban'), model.sending ? 'Revoking…' : ['Revoke ', release.version]),
    ],
  });
}
