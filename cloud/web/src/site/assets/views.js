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
  busyBoards, compareVersions, dayLabel, deploymentHref, describeAudit, describeCounts,
  describeDeployment, describeExecution, describeStatus, describeUpdate, deviceHref, duration,
  exactBytes, exactTime, fileSize, isUnfinished, parseVersion, plural, reviewImage, signalQuality,
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
  restart: [['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }], ['polyline', { points: '19.5 3.5 19.5 7.5 15.5 7.5' }]],
  shield: [
    ['path', { d: 'M12 3.5l7 2.6v5.4c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6.1z' }],
    ['polyline', { points: '9 12.2 11.2 14.4 15.2 9.9' }],
  ],
  pulse: [['polyline', { points: '3 12 7.5 12 10 6 14 18 16.5 12 21 12' }]],
  press: [RING, ['circle', { cx: 12, cy: 12, r: 3.5 }]],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 }]],
  hourglass: [['path', { d: 'M7 4h10M7 20h10M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8' }]],
  offline: [['path', { d: 'M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1M5 4l14 16' }]],
  online: [['path', { d: 'M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1' }]],
  chip: [
    ['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }],
    ['path', { d: 'M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3' }],
  ],
  package: [['path', { d: 'M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM4.5 7.7l7.5 4.3 7.5-4.3M12 12v8.5' }]],
  send: [['path', { d: 'M20.5 3.5L10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4z' }]],
  list: [['path', { d: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1' }]],
  user: [['circle', { cx: 12, cy: 8.5, r: 3.5 }], ['path', { d: 'M5 20a7 7 0 0 1 14 0' }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }]],
  'arrow-right': [['path', { d: 'M5 12h14' }], ['polyline', { points: '13 6 19 12 13 18' }]],
  'arrow-left': [['path', { d: 'M19 12H5' }], ['polyline', { points: '11 6 5 12 11 18' }]],
  'chevron-down': [['polyline', { points: '6 9 12 15 18 9' }]],
  key: [['circle', { cx: 8, cy: 15.5, r: 4 }], ['path', { d: 'M11 12.6l8.5-8.6M15.5 8l3 3' }]],
  lock: [['rect', { x: 5.5, y: 11, width: 13, height: 9, rx: 2 }], ['path', { d: 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3' }]],
  info: [RING, ['path', { d: 'M12 11v5.5M12 7.8v.1' }]],
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
  return h('svg', { class: `icon ${className}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    shapes.map(([tag, attributes]) => h(tag, attributes)));
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

function when(iso, now, prefix = '') {
  if (!iso) return null;
  return h('time', { datetime: iso, title: exactTime(iso) }, `${prefix}${timeAgo(iso, now)}`);
}

function who(person) {
  return person?.email ? person.email : 'someone';
}

function signed(number) {
  return number < 0 ? `−${Math.abs(number)}` : String(number);
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

function empty({ iconName, title, text, command, action }) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty-icon' }, icon(iconName)),
    h('p', { class: 'empty-title' }, title),
    text ? h('p', { class: 'empty-text' }, text) : null,
    command ? h('code', { class: 'code' }, command) : null,
    action ?? null);
}

function notice(tone, iconName, children, action) {
  return h('div', { class: `notice is-${tone}`, role: tone === 'bad' ? 'alert' : null },
    icon(iconName), h('div', { class: 'notice-text' }, children), action ?? null);
}

/** What went wrong with a request: the server's own words, then how to refer to it. */
function problem(error) {
  const coded = error.status >= 400 && error.code && error.code !== 'gateway' && error.code !== 'http';
  return [
    error.message,
    coded || error.requestId
      ? h('span', { class: 'notice-ref dotted' },
        coded ? h('span', null, 'Code ', mono(error.code)) : null,
        error.requestId ? h('span', null, 'Request ', mono(error.requestId)) : null)
      : null,
  ];
}

function loadProblem(resource, what, ctx) {
  if (!resource.error) return null;
  const lead = resource.value ? `Could not refresh ${what}. ` : `Could not load ${what}. `;
  return h('div', { key: `problem-${what}`, class: 'page-notice' },
    notice('bad', 'alert', [
      h('strong', null, lead),
      problem(resource.error),
      resource.value ? ` Showing what was loaded ${timeAgo(new Date(resource.loadedAt).toISOString(), ctx.state.now)}.` : null,
    ], h('button', { type: 'button', class: 'btn is-small', onClick: ctx.actions.refresh }, 'Try again')));
}

function loading(what) {
  return h('p', { class: 'loading', key: 'loading' }, `Loading ${what}…`);
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
      ? h('span', { class: 'freshness-live', title: 'Refreshing by itself. Paused while this tab is in the background.' },
        h('span', { class: 'live-dot' }), `Live · every ${interval / 1000} s`)
      : resource.loadedAt
        ? h('span', { class: 'freshness-age' }, `Updated ${timeAgo(new Date(resource.loadedAt).toISOString(), now)}`)
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
        eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null,
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, title),
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
    return badge('good', 'online', 'Online', device.lastSeen ? `Last report ${timeAgo(device.lastSeen, now)}` : null);
  }
  if (!device.lastSeen) return badge('idle', 'minus-circle', 'Never connected');
  return badge('idle', 'offline', 'Offline', `Last seen ${exactTime(device.lastSeen)}`);
}

function statusLine(description, extra) {
  return h('span', { class: `status is-${description.tone}` }, icon(description.icon), h('span', null, description.title ?? description.label), extra ?? null);
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

function stepList(description) {
  return h('ol', { class: 'steps', 'aria-label': 'Steps of the update' }, description.steps.map((step, index) => {
    const state = STEP_STATES[step.state];
    const percent = index === 2 && step.state === 'current' && description.progress !== null ? ` ${description.progress}%` : '';
    return h('li', {
      key: step.label,
      class: `step is-${step.state}`,
      'aria-current': step.state === 'current' ? 'step' : null,
    },
    h('span', { class: 'step-mark' }, state.icon ? icon(state.icon) : null),
    h('span', { class: 'step-label' }, step.label, percent),
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
    action ? h('button', { type: 'button', class: `btn ${action.quiet ? '' : 'is-primary'}`.trim(), onClick: action.run }, action.label) : null);
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
  const { me, sessionLeft, accountOpen } = ctx.state;
  const left = Math.max(0, sessionLeft);
  const ends = new Date(Date.now() + left * 1000);
  const role = me.canWrite ? 'Release manager' : 'Viewer';
  return h('div', { class: `account-box ${accountOpen ? 'is-open' : ''}`.trim() },
    h('button', {
      type: 'button',
      class: 'btn is-quiet account-toggle',
      'aria-expanded': accountOpen ? 'true' : 'false',
      'aria-controls': 'account-panel',
      onClick: ctx.actions.toggleAccount,
    }, icon('user'), h('span', null, role), icon('chevron-down', 'is-small')),
    h('div', { class: 'account-panel', id: 'account-panel' },
      h('div', { class: 'account-who' },
        h('span', { class: 'account-email', title: me.email }, me.email || 'Signed in'),
        h('span', { class: 'account-meta' },
          h('span', { class: 'account-role' }, icon(me.canWrite ? 'key' : 'user', 'is-small'), role),
          h('span', {
            class: 'account-session',
            title: `You will be asked to sign in again at ${ends.toLocaleTimeString()}.`,
          }, `Session ends in ${duration(left)}`))),
      h('button', { type: 'button', class: 'btn is-small', onClick: ctx.actions.signOut }, icon('sign-out'), 'Sign out')));
}

// Overview.

/** One entry of the activity log. The short form is for the overview. */
function activityLine(entry, ctx, compact) {
  const description = describeAudit(entry);
  const email = who(entry.actor);
  const label = compact ? versionOfDeployment(entry.target) ?? entry.target : entry.target;
  const outcome = description.outcome
    ? [' ', badge(description.outcome.tone, description.outcome.icon, description.outcome.label)]
    : null;
  return h('li', { key: `${entry.at}-${entry.requestId}`, class: 'log-line' },
    h('span', { class: 'log-icon' }, icon(description.icon)),
    h('div', { class: 'log-body' },
      h('p', { class: 'log-what' },
        h('span', { class: 'log-actor', title: compact ? email : null }, compact ? email.split('@')[0] : email),
        ` ${description.verb} `,
        label ? linkTo(description.href, { class: 'mono log-target' }, label) : null,
        outcome),
      compact
        ? null
        : h('p', { class: 'log-detail dotted' },
          entry.detail.map(([name, value]) => h('span', { key: name }, `${name}: `, mono(value))),
          entry.requestId ? h('span', { key: 'request', class: 'log-ref' }, 'Request ', mono(entry.requestId)) : null)),
    h('span', { class: 'log-when' }, when(entry.at, ctx.state.now)));
}

/** One board of a deployment that is under way, as a line on the overview. */
function boardLine(execution, now, known) {
  const description = describeExecution(execution);
  const lastSeen = known?.lastSeen ?? null;
  return h('li', { key: execution.thing, class: 'board-run' },
    linkTo(deviceHref(execution.thing), { class: 'mono board-run-name' }, execution.thing),
    h('div', { class: 'board-run-state' },
      statusLine(description),
      description.progress !== null
        ? meter(description.progress, `Download on ${execution.thing}`)
        : h('span', { class: 'board-run-note' }, description.brief,
          execution.phase === 'waiting_for_device' && !execution.online && lastSeen ? [' Last seen ', when(lastSeen, now), '.'] : null)));
}

function startedBy(deployment, now) {
  return ['Started ', when(deployment.createdAt, now), deployment.createdBy ? ` by ${who(deployment.createdBy)}` : null];
}

function gettingStarted(ctx, have) {
  const { canWrite } = ctx.state.me;
  const item = (done, title, text, extra) => h('li', { key: title, class: `guide-step ${done ? 'is-done' : ''}`.trim() },
    h('span', { class: 'guide-mark' }, done ? icon('check') : null),
    h('div', null,
      h('p', { class: 'guide-title' }, title, done ? h('span', { class: 'sr-only' }, ' (done)') : null),
      h('p', { class: 'guide-text' }, text, extra ?? null)));
  return card({ key: 'guide', title: 'Getting started', className: 'guide' },
    h('ol', { class: 'guide-steps' },
      item(have.boards, 'Register a board',
        'Each board gets its own certificate and name. With the board connected over USB, run ',
        h('code', { class: 'code' }, 'python3 tools/provision_device.py')),
      item(have.releases, 'Upload a signed image',
        canWrite
          ? ['Drop the build’s zephyr.signed.bin on the ', h('a', { href: '#/firmware' }, 'Firmware'), ' page. The server checks its signature before it is stored.']
          : 'A release manager uploads the build’s zephyr.signed.bin. The server checks its signature before it is stored.'),
      item(have.deployments, 'Deploy it',
        canWrite
          ? ['Start a deployment on the ', h('a', { href: '#/deployments' }, 'Deployments'), ' page, then press Button 1 on the board to install.']
          : 'A release manager offers the release to boards; pressing Button 1 on a board installs it.')));
}

export function overviewView(ctx) {
  const { state } = ctx;
  const { now } = state;
  const devices = state.devices.value?.devices ?? null;
  const firmware = state.firmware.value;
  const deployments = state.deployments.value;
  const recent = state.recent.value?.entries ?? null;
  const byThing = new Map((devices ?? []).map((device) => [device.thing, device]));

  const online = (devices ?? []).filter((device) => device.online).length;
  const boards = card({ key: 'boards', title: 'Boards', more: { href: '#/devices', label: 'All devices' }, className: 'overview-boards' },
    devices === null
      ? (state.devices.error ? null : loading('boards'))
      : devices.length === 0
        ? empty({
          iconName: 'chip',
          title: 'No boards are registered yet.',
          text: 'Provision one with',
          command: 'python3 tools/provision_device.py',
        })
        : [
          h('p', { class: 'figure', key: 'figure' },
            h('span', { class: 'figure-value' }, String(online)),
            h('span', { class: 'figure-unit' }, ` of ${plural(devices.length, 'board')} online`)),
          h('ul', { class: 'board-list', key: 'list' }, devices.map((device) => h('li', { key: device.thing, class: 'board-line' },
            h('span', { class: `presence-dot ${device.online ? 'is-on' : ''}`.trim() }),
            linkTo(deviceHref(device.thing), { class: 'mono' }, device.thing),
            h('span', { class: 'board-line-note' },
              device.online ? 'Online' : device.lastSeen ? when(device.lastSeen, now, 'Seen ') : 'Never connected')))),
        ]);

  const newest = firmware?.releases.find((release) => release.status === 'active') ?? null;
  const groups = new Map();
  for (const device of devices ?? []) {
    const version = device.fw?.version ?? '';
    groups.set(version, (groups.get(version) ?? []).concat(device));
  }
  const versions = [...groups.keys()].sort((a, b) => {
    if (a === '' || b === '') return a === '' ? 1 : -1;
    return compareVersions(parseVersion(b), parseVersion(a));
  });
  const fleet = card({ key: 'fleet', title: 'Firmware in the fleet' },
    devices === null
      ? (state.devices.error ? null : loading('versions'))
      : versions.length === 0
        ? h('p', { class: 'quiet' }, 'Versions appear here once a board has reported.')
        : h('ul', { class: 'fleet-list' }, versions.map((version) => {
          const members = groups.get(version);
          const trial = members.filter((device) => device.fw && !device.fw.confirmed).length;
          return h('li', { key: version || 'none', class: 'fleet-line' },
            version ? mono(version, 'fleet-version') : h('span', { class: 'fleet-version quiet' }, 'Not reported'),
            h('span', { class: 'pips', 'aria-hidden': 'true' }, members.map((device) => h('span', { key: device.thing, class: 'pip' }))),
            h('span', { class: 'fleet-count' }, plural(members.length, 'board')),
            version && newest?.version === version ? h('span', { class: 'tag' }, 'Newest release') : null,
            trial > 0 ? h('span', { class: 'tag is-warn' }, `${trial} on trial`) : null);
        })));

  const latest = firmware?.releases[0] ?? null;
  const release = card({ key: 'release', title: 'Newest release', more: { href: '#/firmware', label: 'Firmware' } },
    !firmware
      ? (state.firmware.error ? null : loading('releases'))
      : !latest
        ? h('p', { class: 'quiet' }, 'No firmware has been uploaded yet.')
        : [
          h('p', { class: 'release-figure', key: 'version' }, mono(latest.version),
            latest.status === 'revoked' ? badge('bad', 'ban', 'Revoked') : badge('good', 'check-circle', 'Active')),
          h('p', { class: 'card-note', key: 'meta' },
            'Uploaded ', when(latest.uploadedAt, now), ` by ${who(latest.uploadedBy)}`),
          h('p', { class: 'card-note', key: 'size' }, fileSize(latest.size), ' · SHA-256 ', mono(`${latest.sha256.slice(0, 12)}…`)),
          latest.status === 'revoked' && newest
            ? h('p', { class: 'card-note', key: 'active' }, 'Newest release that can be deployed: ', mono(newest.version))
            : null,
        ]);

  const active = (deployments ?? []).filter((deployment) => deployment.status === 'IN_PROGRESS');
  const lastDone = (deployments ?? []).find((deployment) => deployment.status !== 'IN_PROGRESS') ?? null;
  const updates = card({ key: 'updates', title: 'Updates in progress', more: { href: '#/deployments', label: 'All deployments' }, className: 'overview-updates' },
    deployments === null
      ? (state.deployments.error ? null : loading('deployments'))
      : active.length === 0
        ? h('div', { class: 'calm' },
          h('p', { class: 'calm-title' }, icon('check-circle'), 'No update is in progress.'),
          lastDone
            ? h('p', { class: 'card-note' }, 'Last deployment: ',
              linkTo(deploymentHref(lastDone.id), { class: 'mono' }, lastDone.version ?? lastDone.id), ', ',
              describeDeployment(lastDone).label.toLowerCase(), ', ', when(lastDone.completedAt ?? lastDone.createdAt, now))
            : h('p', { class: 'card-note' }, 'Deployments appear here while boards are being updated.'))
        : h('ul', { class: 'run-list' }, active.map((deployment) => {
          const detail = state.deploymentDetails.get(deployment.id)?.value ?? null;
          return h('li', { key: deployment.id, class: 'run' },
            h('div', { class: 'run-head' },
              linkTo(deploymentHref(deployment.id), { class: 'run-version mono' }, deployment.version ?? deployment.id),
              h('span', { class: 'card-note' }, startedBy(deployment, now))),
            detail
              ? h('ul', { class: 'board-runs' }, detail.executions.map((execution) => boardLine(execution, now, byThing.get(execution.thing))))
              : h('p', { class: 'card-note' }, describeCounts(deployment.counts).map((entry) => `${entry.count} ${entry.label}`).join(', ')));
        })));

  const activity = card({ key: 'activity', title: 'Recent activity', more: { href: '#/activity', label: 'All activity' }, className: 'overview-activity' },
    recent === null
      ? (state.recent.error ? null : loading('activity'))
      : recent.length === 0
        ? h('p', { class: 'quiet' }, 'Nothing has been recorded yet. Uploads, deployments, cancellations and revocations will appear here.')
        : h('ul', { class: 'log is-compact' }, recent.slice(0, 5).map((entry) => activityLine(entry, ctx, true))));

  const have = {
    boards: (devices ?? []).length > 0,
    releases: (firmware?.releases ?? []).length > 0,
    deployments: (deployments ?? []).length > 0,
  };
  const loaded = devices !== null && firmware !== null && deployments !== null;

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
    loaded && !(have.boards && have.releases && have.deployments) ? gettingStarted(ctx, have) : null,
    h('div', { class: 'overview', key: 'grid' },
      h('div', { class: 'overview-main' }, updates, h('div', { class: 'overview-pair' }, fleet, release)),
      h('div', { class: 'overview-side' }, boards, activity)));
}

// Devices.

function firmwareFact(device) {
  if (!device.fw) return h('span', { class: 'quiet' }, 'Not reported');
  return [
    mono(device.fw.version, 'fact-strong'),
    device.fw.confirmed
      ? badge('good', 'check', 'Confirmed')
      : badge('warn', 'pulse', 'On trial', 'Not confirmed yet. The bootloader goes back to the previous firmware if the board restarts before it confirms.'),
  ];
}

function updateFact(device) {
  const update = describeUpdate(device);
  return h('div', { class: 'fact-stack' },
    statusLine(update, update.progress !== null ? h('span', { class: 'status-value' }, `${update.progress}%`) : null),
    update.progress !== null ? meter(update.progress, `Download on ${device.thing}`) : null,
    update.text ? h('span', { class: 'fact-note' }, update.text) : null,
    update.deployment
      ? linkTo(deploymentHref(update.deployment), { class: 'fact-link' }, 'Open the deployment', icon('arrow-right', 'is-small'))
      : null);
}

function signalFact(device) {
  const quality = signalQuality(device.rssi);
  if (!quality) return h('span', { class: 'quiet' }, 'Not reported');
  return h('span', { class: 'signal-fact' }, signalBars(quality), `${quality.label} · ${signed(device.rssi)} dBm`);
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
  return h('div', { class: 'page' },
    pageHead({
      title: 'Devices',
      lede: 'Every board registered to this project, as it last reported.',
      tools: freshness(state.devices, ctx),
    }),
    loadProblem(state.devices, 'the boards', ctx),
    devices === null
      ? (state.devices.error ? null : loading('boards'))
      : devices.length === 0
        ? card({ key: 'none' }, empty({
          iconName: 'chip',
          title: 'No boards are registered yet.',
          text: 'Provision one with',
          command: 'python3 tools/provision_device.py',
        }))
        : h('div', { class: 'device-grid', key: 'grid' }, devices.map((device) =>
          h('article', { key: device.thing, class: 'card device' },
            h('header', { class: 'device-head' },
              h('div', null,
                h('h2', { class: 'device-name' }, linkTo(deviceHref(device.thing), { class: 'mono cover-link' }, device.thing)),
                h('p', { class: 'device-seen' }, seenLine(device, state.now))),
              presence(device, state.now)),
            deviceFacts(device)))));
}

export function deviceView(ctx) {
  const { state } = ctx;
  const { thing } = state.route;
  const resource = state.deviceDetails.get(thing) ?? { value: null, error: null, loading: true, loadedAt: 0 };
  const detail = resource.value;
  const head = pageHead({
    back: { href: '#/devices', label: 'Devices' },
    eyebrow: 'Board',
    title: mono(thing),
    lede: detail ? seenLine(detail.device, state.now) : null,
    tools: freshness(resource, ctx),
  });

  if (!detail) {
    return h('div', { class: 'page' }, head, loadProblem(resource, 'this board', ctx), resource.error ? null : loading('the board'));
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
            ? h('p', { class: 'quiet' }, 'No certificate is attached, so this board cannot connect. Run the provisioning tool again.')
            : [
              h('ul', { class: 'plain-list', key: 'list' }, certificates.map((id) =>
                h('li', { key: id }, icon('key', 'is-small'), mono(`${id}…`)))),
              h('p', { class: 'card-note', key: 'note' },
                'The start of each certificate ID. The certificate belongs to this board alone; its private key never leaves the board.'),
            ]),
        card({ key: 'history', title: 'Update history' },
          executions.length === 0
            ? h('p', { class: 'quiet' }, 'This board has not been offered an update yet.')
            : h('ul', { class: 'rows' }, executions.map((execution) => {
              const version = execution.version ?? versionOfDeployment(execution.deployment);
              return h('li', { key: execution.deployment, class: 'row history-row' },
                h('div', { class: 'row-main' },
                  linkTo(deploymentHref(execution.deployment), { class: 'mono row-title cover-link' }, version ?? execution.deployment),
                  h('span', { class: 'row-note' }, 'Offered ', when(execution.queuedAt, state.now),
                    isUnfinished(execution.status) ? null : [' · ended ', when(execution.lastUpdatedAt, state.now)])),
                statusLine(describeStatus(execution.status)));
            }))))));
}

// Firmware.

function trustPanel(ctx) {
  const fingerprint = ctx.state.firmware.value?.fingerprint ?? '';
  return h('div', { class: 'trust' },
    h('h2', { class: 'trust-title' }, icon('shield'), 'The server verifies every upload'),
    h('p', null,
      'An image is stored only if its ECDSA P-256 signature checks out against this project’s signing key. ',
      'The board’s bootloader checks the same signature again before it starts the image.'),
    h('p', null,
      'The console holds only the public half of that key. It can check a signature; it can never make one, and neither can anyone who signs in here.'),
    fingerprint
      ? h('div', { class: 'fingerprint' },
        h('p', { class: 'eyebrow' }, 'Signing key fingerprint · SHA-256'),
        h('div', { class: 'digest-row' }, mono(fingerprint, 'digest'), copyButton(fingerprint, 'the key fingerprint', ctx)))
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
    onChange: (event) => {
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

function uploadPanel(ctx) {
  const { upload } = ctx.state;
  const firmware = ctx.state.firmware.value;

  if (upload.stage === 'idle') return dropZone(ctx);
  if (upload.stage === 'reading') {
    return h('div', { class: 'upload-state', role: 'status' }, h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)), h('p', { class: 'quiet' }, 'Reading the file…'));
  }
  if (upload.stage === 'done') {
    return h('div', { class: 'upload-state', role: 'status' },
      h('p', { class: 'upload-title is-good' }, icon('check-circle'), 'Registered as ', mono(upload.release.version)),
      h('p', null, 'The signature is valid and the image is stored. It can now be offered to boards.'),
      h('div', { class: 'button-row' },
        h('button', { type: 'button', class: 'btn is-primary', onClick: () => ctx.actions.openDeploy(upload.release.version) }, icon('send'), 'Deploy this release'),
        h('button', { type: 'button', class: 'btn', onClick: ctx.actions.resetUpload }, 'Upload another')));
  }

  const review = reviewImage(upload, firmware);
  const busy = upload.stage === 'sending' || upload.stage === 'checking';
  const changed = upload.recordedAs !== upload.name;
  return h('div', { class: 'upload-state' },
    h('div', { class: 'upload-file' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      busy ? null : h('button', { type: 'button', class: 'btn is-small', onClick: ctx.actions.resetUpload }, 'Choose another file')),
    upload.header.ok
      ? facts([
        ['Version', mono(upload.header.version, 'fact-strong')],
        ['Size', `${exactBytes(upload.size)} (${fileSize(upload.size)})`],
        ['SHA-256', mono(upload.digest, 'digest')],
        ['Layout', `${exactBytes(upload.header.headerSize)} of header, ${exactBytes(upload.header.payloadSize)} of firmware`],
        changed ? ['Recorded as', mono(upload.recordedAs)] : null,
      ])
      : null,
    h('ul', { class: 'checks' }, review.notes.map((note) => h('li', { key: note.text, class: `check is-${note.tone}` },
      icon(note.tone === 'good' ? 'check-circle' : note.tone === 'warn' ? 'alert' : 'x-circle'), h('span', null, note.text)))),
    upload.stage === 'refused'
      ? notice('bad', 'x-circle', [
        h('strong', null, upload.error.status >= 400 ? 'The server refused this image. ' : 'The upload did not go through. '),
        problem(upload.error),
      ])
      : null,
    busy
      ? h('div', { class: 'upload-progress', role: 'status' },
        upload.stage === 'sending'
          ? [h('p', { key: 'label' }, `Uploading… ${Math.round(upload.sent * 100)}%`), meter(Math.round(upload.sent * 100), 'Upload')]
          : [h('p', { key: 'label' }, 'Uploaded. The server is checking the signature…'), h('div', { class: 'meter is-busy', key: 'bar' }, h('span', { class: 'meter-fill' }))])
      : review.blocked
        ? null
        : [
          h('label', { class: 'field', key: 'notes' },
            h('span', { class: 'field-label' }, 'Notes ', h('span', { class: 'quiet' }, '(optional)')),
            h('textarea', {
              class: 'input',
              rows: '2',
              maxlength: '500',
              placeholder: 'What changed in this build',
              value: upload.notes,
              onKeydown: ignoreEnter,
              onInput: (event) => ctx.actions.setUploadNotes(event.target.value),
            })),
          h('div', { class: 'button-row', key: 'send' },
            h('button', { type: 'button', class: 'btn is-primary', onClick: ctx.actions.startUpload },
              icon('upload'), upload.stage === 'refused' ? 'Try again' : 'Upload for verification')),
        ]);
}

function releaseRow(release, ctx) {
  const { now, me } = ctx.state;
  const fingerprint = ctx.state.firmware.value.fingerprint;
  const active = release.status === 'active';
  return h('li', { key: release.version, class: `row release ${active ? '' : 'is-revoked'}`.trim() },
    h('div', { class: 'release-main' },
      h('div', { class: 'release-title' },
        mono(release.version, 'release-version'),
        active ? badge('good', 'check-circle', 'Active') : badge('bad', 'ban', 'Revoked')),
      release.notes ? h('p', { class: 'release-notes' }, release.notes) : null,
      release.revoked
        ? h('p', { class: 'release-revoked' }, icon('ban', 'is-small'),
          h('span', null, 'Revoked ', when(release.revoked.at, now), ` by ${who(release.revoked.by)}: `, release.revoked.reason))
        : null,
      h('p', { class: 'row-note dotted' },
        h('span', null, fileSize(release.size)),
        h('span', null, 'Uploaded ', when(release.uploadedAt, now), ` by ${who(release.uploadedBy)}`),
        h('span', { class: 'digest-row' }, 'SHA-256 ', mono(`${release.sha256.slice(0, 16)}…`),
          copyButton(release.sha256, `the SHA-256 of ${release.version}`, ctx))),
      h('details', { class: 'more' },
        h('summary', null, 'Details'),
        facts([
          ['File', mono(release.filename)],
          ['Size', `${exactBytes(release.size)}: ${exactBytes(release.headerSize)} of header, ${exactBytes(release.payloadSize)} of firmware, then the signature`],
          ['File SHA-256', mono(release.sha256, 'digest'), h('span', { class: 'fact-note' }, 'What a board checks after downloading.')],
          ['Image hash', mono(release.imageHash, 'digest'), h('span', { class: 'fact-note' }, 'What the signature covers and the bootloader verifies.')],
          ['Signed with', mono(release.keyHash, 'digest'),
            h('span', { class: 'fact-note' }, release.keyHash === fingerprint ? 'Matches this project’s signing key.' : 'Fingerprint of the key that signed it.')],
          ['Load address', mono(`0x${(release.loadAddress ?? 0).toString(16)}`)],
          ['Uploaded', exactTime(release.uploadedAt)],
        ]))),
    me.canWrite && active
      ? h('div', { class: 'release-actions' },
        h('button', { type: 'button', class: 'btn is-small', onClick: () => ctx.actions.openDeploy(release.version) }, icon('send'), 'Deploy'),
        h('button', { type: 'button', class: 'btn is-small is-danger-quiet', onClick: () => ctx.actions.openRevoke(release) }, icon('ban'), 'Revoke'))
      : null);
}

export function firmwareView(ctx) {
  const { state } = ctx;
  const firmware = state.firmware.value;
  const { canWrite } = state.me;
  return h('div', { class: 'page' },
    pageHead({
      title: 'Firmware',
      lede: 'Signed images that can be offered to boards. A version, once used, is never reused.',
      tools: freshness(state.firmware, ctx),
    }),
    loadProblem(state.firmware, 'the releases', ctx),
    h('section', { class: `card upload ${canWrite ? '' : 'is-readonly'}`.trim(), key: 'upload' },
      canWrite ? h('div', { class: 'upload-main' }, h('h2', { class: 'eyebrow' }, 'Upload a signed image'), uploadPanel(ctx)) : null,
      trustPanel(ctx)),
    h('h2', { class: 'section-title', key: 'title' }, 'Releases'),
    !firmware
      ? (state.firmware.error ? null : loading('releases'))
      : firmware.releases.length === 0
        ? card({ key: 'none' }, empty({
          iconName: 'package',
          title: 'No firmware has been uploaded yet.',
          text: canWrite
            ? 'Build the firmware, then drop build/app/zephyr/zephyr.signed.bin above to register the first release.'
            : 'A release manager can upload the first signed image.',
        }))
        : card({ key: 'releases', className: 'is-flush' },
          h('ul', { class: 'rows' }, firmware.releases.map((release) => releaseRow(release, ctx)))));
}

// Deployments.

function countList(counts) {
  const entries = describeCounts(counts);
  return h('ul', { class: 'counts' }, entries.map((entry) =>
    h('li', { key: entry.name, class: `status is-${entry.tone}` }, icon(entry.icon), h('span', null, `${entry.count} ${entry.label}`))));
}

export function deploymentsView(ctx) {
  const { state } = ctx;
  const deployments = state.deployments.value;
  const { canWrite } = state.me;
  const hasRelease = (state.firmware.value?.releases ?? []).some((release) => release.status === 'active');
  const start = canWrite
    ? h('button', { type: 'button', class: 'btn is-primary', onClick: () => ctx.actions.openDeploy(null) }, icon('plus'), 'New deployment')
    : null;
  return h('div', { class: 'page' },
    pageHead({
      title: 'Deployments',
      lede: 'A deployment offers one release to a set of boards. Each board installs it when someone presses its Button 1.',
      tools: [freshness(state.deployments, ctx), start],
    }),
    loadProblem(state.deployments, 'the deployments', ctx),
    deployments === null
      ? (state.deployments.error ? null : loading('deployments'))
      : deployments.length === 0
        ? card({ key: 'none' }, empty({
          iconName: 'send',
          title: 'No deployments yet.',
          text: !canWrite
            ? 'When a release manager offers a release to boards, it appears here.'
            : state.firmware.value && !hasRelease
              ? 'Upload a signed image on the Firmware page first; then it can be offered to boards here.'
              : 'Choose New deployment to offer a release to one or more boards.',
        }))
        : card({ key: 'list', className: 'is-flush' },
          h('ul', { class: 'rows' }, deployments.map((deployment) => {
            const summary = describeDeployment(deployment);
            return h('li', { key: deployment.id, class: 'row deployment-row' },
              h('div', { class: 'row-main' },
                h('div', { class: 'release-title' },
                  linkTo(deploymentHref(deployment.id), { class: 'mono release-version cover-link' }, deployment.version ?? 'Unknown version'),
                  badge(summary.tone, summary.icon, summary.label)),
                deployment.note ? h('p', { class: 'release-notes' }, deployment.note) : null,
                h('p', { class: 'row-note' }, startedBy(deployment, state.now), ` · ${plural(deployment.things.length, 'board')}`)),
              countList(deployment.counts),
              h('span', { class: 'row-chevron' }, icon('arrow-right')));
          }))));
}

function executionCard(execution, ctx) {
  const { now } = ctx.state;
  const description = describeExecution(execution);
  const known = (ctx.state.devices.value?.devices ?? []).find((device) => device.thing === execution.thing) ?? null;
  const reported = execution.running ?? null;
  const moments = [
    execution.queuedAt ? ['Offered ', when(execution.queuedAt, now)] : null,
    execution.startedAt ? ['Started ', when(execution.startedAt, now)] : null,
    execution.lastUpdatedAt && execution.startedAt ? ['Last report ', when(execution.lastUpdatedAt, now)] : null,
    execution.status === 'IN_PROGRESS' && execution.secondsLeft !== null ? `Times out in ${duration(execution.secondsLeft)}` : null,
    !reported && known?.fw && !isUnfinished(execution.status) ? ['Board now reports ', mono(known.fw.version)] : null,
    !execution.online && known?.lastSeen ? ['Board last seen ', when(known.lastSeen, now)] : null,
  ].filter(Boolean);

  return h('article', { key: execution.thing, class: `card execution is-${description.tone}` },
    h('header', { class: 'execution-head' },
      h('h2', { class: 'execution-name' }, linkTo(deviceHref(execution.thing), { class: 'mono' }, execution.thing)),
      execution.online ? badge('good', 'online', 'Online') : badge('idle', 'offline', 'Offline')),
    h('div', { class: 'execution-state' },
      h('p', { class: `execution-title status is-${description.tone}`, role: 'status' }, icon(description.icon), h('span', null, description.title)),
      h('p', { class: 'execution-text' }, description.text),
      description.code ? h('p', { class: 'execution-code' }, 'The board gave the reason ', mono(description.code)) : null,
      execution.detail ? h('p', { class: 'execution-code' }, 'Board’s note: ', mono(execution.detail)) : null,
      description.progress !== null ? meter(description.progress, `Download on ${execution.thing}`) : null),
    stepList(description),
    moments.length
      ? h('p', { class: 'execution-foot dotted' }, moments.map((moment, index) => h('span', { key: String(index) }, moment)))
      : null);
}

export function deploymentView(ctx) {
  const { state } = ctx;
  const { id } = state.route;
  const resource = state.deploymentDetails.get(id) ?? { value: null, error: null, loading: true, loadedAt: 0 };
  const deployment = resource.value;
  const version = deployment?.version ?? versionOfDeployment(id);
  const summary = deployment ? describeDeployment(deployment) : null;
  const unfinished = deployment ? deployment.executions.some((execution) => isUnfinished(execution.status)) : false;

  const head = pageHead({
    back: { href: '#/deployments', label: 'Deployments' },
    eyebrow: 'Deployment of',
    title: [mono(version ?? 'unknown version'), summary ? badge(summary.tone, summary.icon, summary.label) : null],
    lede: deployment?.note || null,
    meta: deployment
      ? [
        h('span', null, startedBy(deployment, state.now),
          deployment.completedAt ? [', finished ', when(deployment.completedAt, state.now)] : null),
        h('span', { class: 'digest-row' }, mono(deployment.id), copyButton(deployment.id, 'the deployment ID', ctx)),
      ]
      : null,
    tools: [
      freshness(resource, ctx),
      state.me.canWrite && unfinished
        ? h('button', { type: 'button', class: 'btn is-danger-quiet', onClick: () => ctx.actions.openCancel(deployment) }, icon('stop'), 'Cancel deployment')
        : null,
    ],
  });

  if (!deployment) {
    return h('div', { class: 'page' }, head, loadProblem(resource, 'this deployment', ctx), resource.error ? null : loading('the deployment'));
  }
  return h('div', { class: 'page' },
    head,
    loadProblem(resource, 'this deployment', ctx),
    deployment.executions.length === 0
      ? card({ key: 'none' }, h('p', { class: 'quiet' }, 'AWS IoT has not listed any board for this deployment yet.'))
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
  return h('div', { class: 'page' },
    pageHead({
      title: 'Activity',
      lede: 'Every upload, deployment, cancellation and revocation, with who asked for it and how it ended. Entries cannot be changed.',
      tools: freshness(state.audit, ctx),
    }),
    loadProblem(state.audit, 'the activity log', ctx),
    !audit
      ? (state.audit.error ? null : loading('activity'))
      : audit.entries.length === 0
        ? card({ key: 'none' }, empty({
          iconName: 'list',
          title: 'Nothing has been recorded yet.',
          text: 'Uploads, deployments, cancellations and revocations will appear here, including attempts that were refused.',
        }))
        : [
          days.map((day) => h('section', { key: day.label, class: 'log-day' },
            h('h2', { class: 'eyebrow' }, day.label),
            card({ className: 'is-flush' }, h('ul', { class: 'log' }, day.entries.map((entry) => activityLine(entry, ctx, false)))))),
          h('div', { class: 'log-more', key: 'more' },
            audit.next
              ? h('button', { type: 'button', class: 'btn', disabled: state.audit.loadingMore, onClick: ctx.actions.loadMoreActivity },
                state.audit.loadingMore ? 'Loading…' : 'Load more')
              : h('p', { class: 'quiet' }, 'That is the whole log.'),
            state.audit.moreError ? notice('bad', 'alert', problem(state.audit.moreError)) : null),
        ]);
}

// Dialogs. Each is a form inside a <dialog>; its buttons say what they do.

/** Enter in a field neither submits a dialog nor starts a new line in a one-line text. */
function ignoreEnter(event) {
  if (event.key === 'Enter' && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) {
    event.preventDefault();
  }
}

function dialogFrame({ title, body, foot, onSubmit, onClose, busy }) {
  return h('form', {
    class: 'dialog-form',
    method: 'dialog',
    onKeydown: ignoreEnter,
    onSubmit: (event) => {
      event.preventDefault();
      if (onSubmit) onSubmit();
    },
  },
  h('header', { class: 'dialog-head' },
    h('h2', { class: 'dialog-title', id: 'dialog-title' }, title),
    h('button', { type: 'button', class: 'btn is-quiet is-icon', 'aria-label': 'Close', disabled: busy, onClick: onClose }, icon('x'))),
  h('div', { class: 'dialog-body' }, body),
  h('footer', { class: 'dialog-foot' }, foot));
}

function consequences(items) {
  return h('ul', { class: 'consequences' }, items.map((item, index) => h('li', { key: String(index) }, item)));
}

const WIZARD_STEPS = ['Release', 'Boards', 'Review'];

function wizardBoard(device, model, now) {
  const busy = model.busy.get(device.thing) ?? null;
  const chosen = model.things.has(device.thing);
  const target = parseVersion(model.version);
  const runs = device.fw ? parseVersion(device.fw.version) : null;
  const pointless = target && runs && compareVersions(runs, target) >= 0;
  return h('label', { key: device.thing, class: `choice ${busy ? 'is-disabled' : ''}`.trim() },
    h('input', {
      type: 'checkbox',
      checked: chosen,
      disabled: Boolean(busy),
      onChange: () => model.toggle(device.thing),
    }),
    h('span', { class: 'choice-body' },
      h('span', { class: 'choice-title' }, mono(device.thing), presence(device, now)),
      h('span', { class: 'choice-note' },
        device.fw ? ['Runs ', mono(device.fw.version)] : 'Has not reported a version',
        device.online || !device.lastSeen ? null : [' · last seen ', when(device.lastSeen, now)]),
      busy
        ? h('span', { class: 'choice-warning' }, icon('lock', 'is-small'),
          h('span', null, 'Has an unfinished update', busy.version ? [' to ', mono(busy.version)] : null,
            `. Finish or cancel that deployment first.`))
        : pointless && chosen
          ? h('span', { class: 'choice-warning' }, icon('alert', 'is-small'),
            h('span', null, 'Reports that it already runs this version or a newer one, so it will refuse the offer.'))
          : !device.online && chosen
            ? h('span', { class: 'choice-hint' }, 'Offline: it will see the offer when it reconnects.')
            : null));
}

export function deployDialog(model, ctx) {
  const { now } = ctx.state;
  const releases = model.releases ?? [];
  const devices = model.devices ?? [];
  const release = releases.find((candidate) => candidate.version === model.version) ?? null;
  const chosen = devices.filter((device) => model.things.has(device.thing));
  const free = devices.filter((device) => !model.busy.has(device.thing));

  let body;
  if (model.loading) {
    body = loading('releases and boards');
  } else if (model.loadError) {
    body = notice('bad', 'alert', [h('strong', null, 'Could not load what a deployment needs. '), problem(model.loadError)],
      h('button', { type: 'button', class: 'btn is-small', onClick: model.reload }, 'Try again'));
  } else if (model.step === 0) {
    body = releases.length === 0
      ? empty({ iconName: 'package', title: 'There is no release to deploy.', text: 'Upload a signed image on the Firmware page first. Revoked releases cannot be deployed.' })
      : h('fieldset', { class: 'choices' },
        h('legend', null, 'Which release?'),
        releases.map((candidate) => h('label', { key: candidate.version, class: 'choice' },
          h('input', {
            type: 'radio',
            name: 'release',
            checked: candidate.version === model.version,
            onChange: () => model.choose(candidate.version),
          }),
          h('span', { class: 'choice-body' },
            h('span', { class: 'choice-title' }, mono(candidate.version)),
            h('span', { class: 'choice-note' }, fileSize(candidate.size), ' · uploaded ', when(candidate.uploadedAt, now), ` by ${who(candidate.uploadedBy)}`),
            candidate.notes ? h('span', { class: 'choice-note' }, candidate.notes) : null))));
  } else if (model.step === 1) {
    body = devices.length === 0
      ? empty({ iconName: 'chip', title: 'No boards are registered yet.', text: 'Provision one with', command: 'python3 tools/provision_device.py' })
      : h('fieldset', { class: 'choices' },
        h('legend', null, 'Which boards get ', mono(model.version), '?'),
        devices.map((device) => wizardBoard(device, model, now)),
        free.length > 1
          ? h('button', { type: 'button', class: 'btn is-small is-quiet', onClick: model.toggleAll },
            chosen.length === free.length ? 'Clear the selection' : `Select all ${free.length} available boards`)
          : null);
  } else {
    const offline = chosen.filter((device) => !device.online).length;
    body = [
      facts([
        ['Release', mono(model.version, 'fact-strong'), release ? h('span', { class: 'fact-note' }, `${fileSize(release.size)} · SHA-256 ${release.sha256.slice(0, 12)}…`) : null],
        ['Boards', h('ul', { class: 'plain-list' }, chosen.map((device) => h('li', { key: device.thing }, mono(device.thing), presence(device, now))))],
      ]),
      h('label', { class: 'field', key: 'note' },
        h('span', { class: 'field-label' }, 'Note ', h('span', { class: 'quiet' }, '(optional, shown with the deployment)')),
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
          ['Each board is offered ', mono(model.version), '. Nothing is installed until someone presses Button 1 on that board; Button 2 declines.'],
          offline > 0
            ? `${plural(offline, 'board is', 'boards are')} offline and will see the offer after reconnecting. The offer stays open until it is cancelled.`
            : 'The offer stays open until a board acts on it or the deployment is cancelled.',
          'A board checks the download and its bootloader checks the signature. If the new firmware cannot reconnect, the bootloader puts the previous one back.',
          'These boards cannot be given another deployment until this one has finished or been cancelled.',
        ])),
    ];
  }

  const busyBoardsRefused = model.error ? busyBoards(model.error) : [];
  const last = model.step === 2;
  const canNext = model.step === 0 ? Boolean(release) : chosen.length > 0;
  return dialogFrame({
    title: 'New deployment',
    busy: model.sending,
    onClose: model.close,
    onSubmit: last ? model.submit : (canNext ? model.next : null),
    body: [
      h('ol', { class: 'wizard-steps', key: 'steps' }, WIZARD_STEPS.map((label, index) => h('li', {
        key: label,
        class: index === model.step ? 'is-current' : index < model.step ? 'is-done' : null,
        'aria-current': index === model.step ? 'step' : null,
      }, h('span', { class: 'wizard-number' }, index < model.step ? icon('check') : String(index + 1)), label))),
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
        ? h('div', { key: 'error' }, notice('bad', 'x-circle', [
          h('strong', null, 'The deployment was not started. '), problem(model.error),
          busyBoardsRefused.length
            ? h('ul', { class: 'plain-list' }, busyBoardsRefused.map((entry) => h('li', { key: entry.thing },
              mono(entry.thing), ' is busy with ', linkTo(deploymentHref(entry.deployment), { class: 'mono' }, entry.deployment ?? 'another deployment'))))
            : null,
        ]))
        : null,
    ],
    foot: [
      h('button', { type: 'button', class: 'btn', key: 'cancel', disabled: model.sending, onClick: model.close }, 'Cancel'),
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      model.step > 0 ? h('button', { type: 'button', class: 'btn', key: 'back', disabled: model.sending, onClick: model.back }, 'Back') : null,
      last
        ? h('button', { type: 'submit', class: 'btn is-primary', key: 'go', disabled: model.sending || chosen.length === 0 },
          icon('send'), model.sending ? 'Starting…' : `Deploy to ${plural(chosen.length, 'board')}`)
        : h('button', { type: 'submit', class: 'btn is-primary', key: 'next', disabled: model.loading || !canNext }, 'Next'),
    ],
  });
}

export function cancelDialog(model) {
  const { deployment } = model;
  const waiting = deployment.executions.filter((execution) => execution.status === 'QUEUED').length;
  const started = deployment.executions.filter((execution) => execution.status === 'IN_PROGRESS').length;
  const option = (force, title, text) => h('label', { class: 'choice', key: String(force) },
    h('input', { type: 'radio', name: 'force', checked: model.force === force, disabled: model.sending, onChange: () => model.setForce(force) }),
    h('span', { class: 'choice-body' }, h('span', { class: 'choice-title' }, title), h('span', { class: 'choice-note' }, text)));
  return dialogFrame({
    title: ['Cancel the deployment of ', mono(deployment.version ?? 'this release'), '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: model.submit,
    body: [
      h('p', { key: 'now' }, 'Right now ', h('strong', null, plural(waiting, 'board is', 'boards are'), ' waiting'), ' and ',
        h('strong', null, plural(started, 'board has', 'boards have'), ' started'), '. Boards that already finished are not affected.'),
      h('fieldset', { class: 'choices', key: 'choices' },
        h('legend', null, 'How far should the cancellation go?'),
        option(false, 'Withdraw the offer',
          'Boards that have not started are no longer offered this update. A board that is already downloading or installing carries on and finishes.'),
        option(true, 'Withdraw the offer and stop boards that have started',
          'Forced. A board that is downloading or checking the image stops before installing, because it asks AWS first and finds the update cancelled. A board that is already restarting into the new firmware cannot be stopped; it may still finish, but it can no longer report the result here.')),
      h('p', { class: 'quiet', key: 'eventually' }, 'A cancellation takes a few seconds to reach every board’s record. It cannot be undone; to try again, start a new deployment.'),
      model.error ? h('div', { key: 'error' }, notice('bad', 'x-circle', [h('strong', null, 'Not cancelled. '), problem(model.error)])) : null,
    ],
    foot: [
      h('button', { type: 'button', class: 'btn', key: 'keep', autofocus: true, disabled: model.sending, onClick: model.close }, 'Keep the deployment'),
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      h('button', { type: 'submit', class: 'btn is-danger', key: 'go', disabled: model.sending },
        model.sending ? 'Cancelling…' : model.force ? 'Cancel and stop boards' : 'Cancel the deployment'),
    ],
  });
}

export function revokeDialog(model) {
  const { release } = model;
  const reason = model.reason.trim();
  return dialogFrame({
    title: ['Revoke ', mono(release.version), '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: reason ? model.submit : null,
    body: [
      h('p', { key: 'lead' }, 'Revoking withdraws a release for good. Use it when an image must not be installed any more.'),
      consequences([
        'The image stops downloading at once, also for a board that is in the middle of downloading it.',
        ['Every unfinished deployment of ', mono(release.version), ' is cancelled, including on boards that have already started. They stop before installing.'],
        'It can never be deployed again, and its version number stays used: the next upload must still be newer.',
        ['Boards that already run ', mono(release.version), ' keep running it. To replace it there, upload a newer version and deploy that.'],
        'This cannot be undone.',
      ]),
      h('label', { class: 'field', key: 'reason' },
        h('span', { class: 'field-label' }, 'Reason'),
        h('textarea', {
          class: 'input',
          rows: '2',
          maxlength: '200',
          required: true,
          autofocus: true,
          disabled: model.sending,
          value: model.reason,
          onInput: (event) => model.setReason(event.target.value),
        }),
        h('span', { class: 'field-hint' }, 'Recorded in the activity log and shown next to the release.')),
      model.error ? h('div', { key: 'error' }, notice('bad', 'x-circle', [h('strong', null, 'Not revoked. '), problem(model.error)])) : null,
    ],
    foot: [
      h('button', { type: 'button', class: 'btn', key: 'keep', disabled: model.sending, onClick: model.close }, 'Keep the release'),
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      h('button', { type: 'submit', class: 'btn is-danger', key: 'go', disabled: model.sending || !reason },
        icon('ban'), model.sending ? 'Revoking…' : ['Revoke ', release.version]),
    ],
  });
}
