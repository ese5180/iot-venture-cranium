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
  FIRST_WITH_NO_BUTTON, SESSION_WARNING_S, STEPS, alreadyRuns, asksForButton, busyBoards, canRetryUpload, clockTime, compareVersions, dateAndTime, dayLabel,
  deploymentHref, describeAudit, describeCounts, describeDeployment, describeExecution, describeHistory,
  describeUpdate, deviceActivity, deviceHref, duration, exactBytes, exactTime, failedCheck, fileSize, IMAGE_CHECKS,
  installStanding, isRefusal, isRestarting, isUnderWay, isUnfinished, isUnregistered, nameOf, parseVersion, plainMessage,
  plural, reviewImage, revocationState, sentence, shortAccount, signalQuality, singleLine, stillFinishing, timeAgo,
  timeOfDay, toldByDate, versionOfDeployment,
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
  swap: [
    ['polyline', { points: '8 4 4 8 8 12' }], ['path', { d: 'M4 8h13' }],
    ['polyline', { points: '16 12 20 16 16 20' }], ['path', { d: 'M20 16H7' }],
  ],
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

// Brand artwork. All of it is decoration: it says nothing that the words beside it do not.

const DOME = 'M2 18a14 14 0 0 1 28 0v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z';
const GROOVES = 'M7 30V18a9 9 0 0 1 18 0v12M12 30V18a4 4 0 0 1 8 0v12';

/** The mark: a dome cut with the grooves of a record. */
export function brandMark(className = '') {
  return h('svg', {
    class: `brand-mark ${className}`.trim(),
    viewBox: '0 0 32 32',
    'aria-hidden': 'true',
    focusable: 'false',
  }, h('path', { class: 'brand-dome', d: DOME }), h('path', { class: 'brand-grooves', d: GROOVES }));
}

/** The same dome at the scale of a wall, rising from the bottom edge of what holds it. */
function domeArt(className = '') {
  const grooves = [];
  for (let radius = 52, step = 0; radius < 430; step += 1, radius += 34 + step * 1.5) {
    grooves.push(h('path', {
      key: String(step),
      class: 'art-groove',
      pathLength: '1',
      d: `M${500 - radius} 1000V540a${radius} ${radius} 0 0 1 ${radius * 2} 0V1000`,
      vars: { '--step': String(step) },
    }));
  }
  return h('svg', {
    class: `dome-art ${className}`.trim(),
    viewBox: '0 0 1000 1000',
    preserveAspectRatio: 'xMidYMax meet',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('path', { class: 'art-dome', d: 'M40 1000V540a460 460 0 0 1 920 0V1000z' }),
  grooves);
}

/** Thin arches in the corner of a panel: the dome again, as a watermark. */
function archWatermark() {
  const lines = [];
  for (let radius = 60; radius <= 420; radius += 60) {
    lines.push(h('path', {
      key: String(radius),
      d: `M${440 - radius} 480V${440}a${radius} ${radius} 0 0 1 ${radius * 2} 0V480`,
    }));
  }
  return h('svg', {
    class: 'arch-watermark',
    viewBox: '0 0 880 480',
    preserveAspectRatio: 'xMaxYMax meet',
    'aria-hidden': 'true',
    focusable: 'false',
  }, lines);
}

// Line drawings for pages with nothing on them yet.

const DRAWINGS = {
  // A development board: its chip, its pin headers, a button and an LED.
  chip: [
    ['rect', { x: 18, y: 14, width: 124, height: 72, rx: 5 }],
    ['rect', { x: 66, y: 34, width: 32, height: 32, rx: 2, class: 'is-accent' }],
    ['path', { d: 'M74 34v-5M82 34v-5M90 34v-5M74 66v5M82 66v5M90 66v5M66 42h-5M66 50h-5M66 58h-5M98 42h5M98 50h5M98 58h5' }],
    ['path', { d: 'M26 22h40M122 78h12M26 78h28' }],
    ['rect', { x: 8, y: 40, width: 10, height: 20, rx: 1.5 }],
    ['circle', { cx: 122, cy: 30, r: 4 }],
    ['circle', { cx: 122, cy: 50, r: 7 }],
  ],
  // Two flash slots: one holds an image, the other is free.
  package: [
    ['rect', { x: 20, y: 16, width: 120, height: 28, rx: 3, class: 'is-accent' }],
    ['rect', { x: 20, y: 56, width: 120, height: 28, rx: 3, class: 'is-dashed' }],
    ['path', { d: 'M32 26h44M32 34h28' }],
    ['path', { d: 'M122 24l6 2.2v4c0 3.2-2.4 5.2-6 6.8-3.6-1.6-6-3.6-6-6.8v-4z' }],
  ],
  // A release on its way out to three boards.
  send: [
    ['circle', { cx: 28, cy: 50, r: 10, class: 'is-accent' }],
    ['path', { d: 'M38 50h30M68 50c16 0 18-26 34-26h14M68 50h48M68 50c16 0 18 26 34 26h14' }],
    ['rect', { x: 116, y: 15, width: 26, height: 18, rx: 2 }],
    ['rect', { x: 116, y: 41, width: 26, height: 18, rx: 2 }],
    ['rect', { x: 116, y: 67, width: 26, height: 18, rx: 2 }],
  ],
  // A ledger: lines that have not been written yet.
  list: [
    ['path', { d: 'M48 12v76' }],
    ['circle', { cx: 48, cy: 26, r: 5, class: 'is-accent' }],
    ['circle', { cx: 48, cy: 50, r: 5 }],
    ['circle', { cx: 48, cy: 74, r: 5 }],
    ['path', { class: 'is-dashed', d: 'M64 26h64M64 50h48M64 74h56' }],
  ],
};

function drawing(name) {
  const shapes = DRAWINGS[name];
  if (!shapes) return null;
  return h('svg', {
    class: 'drawing',
    viewBox: '0 0 160 100',
    'aria-hidden': 'true',
    focusable: 'false',
  }, shapes.map(([tag, attributes], index) => h(tag, { ...attributes, key: String(index) })));
}

// Small pieces used by every view.

function badge(tone, iconName, label, title) {
  return h('span', { class: `badge is-${tone}`, title }, icon(iconName), h('span', null, label));
}

function mono(content, className = '') {
  return h('span', { class: `mono ${className}`.trim() }, content);
}

const TECHNICAL = /(\d+\.\d+\.\d+\+\d+|(?:[\w-]+\/)*(?:[\w*-]+\.)?signed\.bin)/;

/** A sentence from core.js, with the versions and the file names in it set in the monospace face. */
function prose(text) {
  return String(text ?? '').split(TECHNICAL).map((part, index) => (index % 2 ? mono(part) : part));
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

/** The same, with the time of day written out: for where the exact moment matters. */
function whenAt(iso, now, prefix = '') {
  if (!iso) return null;
  // Old enough to be told by its date already: the day is not said twice.
  if (toldByDate(iso, now)) return h('time', { datetime: iso, title: exactTime(iso) }, `${prefix}${dateAndTime(iso)}`);
  return [when(iso, now, prefix), ` (${clockTime(iso, now)})`];
}

/** The time of day alone: for an entry under a heading that names its day. */
function whenInDay(iso) {
  if (!iso) return null;
  return h('time', { datetime: iso, title: exactTime(iso) }, timeOfDay(iso));
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

/**
 * One whole split into parts, read at a glance. Each part is a block as wide as its
 * share, with its amount printed on it where it fits; the accessible name gives every
 * part in words, and so does the legend next to it. `tone` picks the fill.
 */
function segments(parts, label, { thin = false } = {}) {
  const shown = parts.filter((part) => part.amount > 0);
  return h('div', {
    class: `segments ${thin ? 'is-thin' : ''}`.trim(),
    role: 'img',
    'aria-label': label,
  }, shown.map((part) => h('span', {
    key: part.key,
    class: `segment is-${part.tone}`,
    title: `${part.name}: ${part.amount}`,
    vars: { '--share': String(part.amount) },
  }, thin ? null : h('span', { class: 'segment-value' }, String(part.amount)))));
}

/** The parts of a board count, as `segments` and describeCounts see them. */
function countParts(counts, atButton = 0) {
  return describeCounts(counts, atButton).map((entry) => ({
    key: entry.name, amount: entry.count, tone: entry.tone, name: entry.label,
  }));
}

function countWords(counts, atButton = 0) {
  return describeCounts(counts, atButton).map((entry) => `${entry.count} ${entry.label}`).join(', ');
}

/** A row of big numbers, each with what it counts. */
function stats(rows) {
  return h('dl', { class: 'stats' }, rows.filter(Boolean).map(([label, value, note]) =>
    h('div', { key: label, class: 'stat' },
      h('dt', { class: 'stat-label' }, label),
      h('dd', { class: 'stat-value' }, String(value)),
      note ? h('dd', { class: 'stat-note' }, note) : null)));
}

/**
 * One tile per board: filled while it is online, an outline once it has gone quiet, a
 * dashed outline if it has never reported. The words next to the tiles count the same.
 */
function boardTiles(devices) {
  const rank = (device) => {
    if (isUp(device)) return 0;
    return device.lastSeen ? 1 : 2;
  };
  const looks = ['is-on', 'is-off', 'is-never'];
  const ordered = [...devices].sort((a, b) => rank(a) - rank(b));
  return h('span', { class: 'tiles', 'aria-hidden': 'true' }, ordered.map((device) =>
    h('span', { key: device.thing, class: `tile ${looks[rank(device)]}`, title: device.thing })));
}

/** Nothing here yet: what that means, and what to do next. `action` is a link drawn as a button. */
function empty({ iconName, title, text, command, action }) {
  return h('div', { class: 'empty' },
    drawing(iconName) ?? h('span', { class: 'empty-icon' }, icon(iconName)),
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
  const coded = error.status >= 400 && error.code && !['gateway', 'http', 'unauthorized'].includes(error.code);
  if (!coded && !error.requestId) return null;
  return h('span', { class: 'notice-ref dotted' },
    coded ? h('span', null, 'Code ', mono(error.code)) : null,
    error.requestId ? h('span', null, 'Request ', mono(error.requestId)) : null);
}

/**
 * A failed action: what did not happen, then the server's own words. Only a refusal
 * (a 4xx reply) says for certain that nothing was done; after anything else the
 * request may have been carried out all the same, and the notice says so. When the
 * session has ended, `signIn` is the way on.
 */
function failure(refusal, error, extra, signIn) {
  const lead = isRefusal(error) ? refusal : 'It is not certain whether this went through.';
  return notice('bad', 'x-circle', [h('strong', null, lead, ' '), sentence(plainMessage(error))], {
    more: [extra ?? null, problemRef(error)],
    action: error.status === 401 && signIn ? button('is-small', signIn, 'Sign in again') : null,
  });
}

function loadProblem(resource, what, ctx) {
  return resource.error ? loadNotice([resource], what, ctx) : null;
}

/** What could not be read. `failed` holds the resources this one notice speaks for. */
function loadNotice(failed, what, ctx) {
  const [{ error }] = failed;
  const stale = failed.filter((resource) => resource.value !== null);
  const oldest = stale.reduce((first, resource) => (resource.loadedAt < first.loadedAt ? resource : first), stale[0]);
  return h('div', { key: `problem-${what}`, class: 'page-notice' },
    notice('bad', 'alert', [
      h('strong', null, stale.length > 0 ? `Could not refresh ${what}. ` : `Could not load ${what}. `),
      sentence(plainMessage(error)),
    ], {
      // The age changes with the clock and the request id with every retry.
      more: [
        stale.length > 0 ? [' Showing what was loaded ', whenLoaded(oldest, ctx.state.now), '.'] : null,
        problemRef(error),
      ],
      action: button('is-small', ctx.actions.refresh, 'Try again'),
    }));
}

/**
 * The same for a page that reads several things. One lost connection fails them all
 * alike: that is one problem, with one way to try again. `items` is [resource, what].
 */
function loadProblems(items, ctx) {
  const failed = items.filter(([resource]) => resource.error);
  if (failed.length === 0) return null;
  const [[{ error: first }]] = failed;
  const alike = failed.every(([{ error }]) => error.message === first.message);
  if (failed.length > 1 && alike) return loadNotice(failed.map(([resource]) => resource), 'this page', ctx);
  return failed.map(([resource, what]) => loadProblem(resource, what, ctx));
}

/** The server knows of no such thing: nothing to try again, and the way back instead. */
function missing(resource) {
  return resource.error?.status === 404;
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
  // A board that is restarting is off for the moment, whatever its last connection says.
  if (isRestarting(device)) return badge('idle', 'restart', 'Restarting');
  if (device.online) {
    const reported = device.lastSeen ? `Last heartbeat ${timeAgo(device.lastSeen, now)}` : null;
    return badge('good', 'online', 'Online', reported);
  }
  if (!device.lastSeen) return badge('idle', 'minus-circle', 'Never connected');
  return badge('idle', 'offline', 'Offline', `Last heartbeat ${exactTime(device.lastSeen)}`);
}

/**
 * The state of a board and when its last heartbeat arrived, or null for one that has never had
 * one. The API says whether it is online. This page does not work that out again from the time.
 */
function heartbeatWords(device, now) {
  let words = ['Offline', 'last heartbeat'];
  if (isRestarting(device)) words = ['Restarting', 'last heartbeat'];
  else if (device.online) words = ['Online', 'heartbeat'];
  if (device.lastSeen) return when(device.lastSeen, now, `${words[0]}, ${words[1]} `);
  return device.online ? words[0] : null;
}

/** An icon and a few words for a state; `description` comes from core.js. */
function statusLine(description, extra) {
  return h('span', { class: `status is-${description.tone} ${description.quiet ? 'is-quiet' : ''}`.trim() },
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

function signalBars(quality, old = false) {
  return h('svg', { class: `signal ${old ? 'is-old' : ''}`.trim(), viewBox: '0 0 22 16', 'aria-hidden': 'true', focusable: 'false' },
    [0, 1, 2, 3].map((index) => h('rect', {
      key: String(index),
      class: index < quality.bars ? 'is-on' : null,
      x: String(index * 6),
      y: String(11 - index * 3.67),
      width: '4',
      height: String(5 + index * 3.67),
      rx: '1',
    })));
}

/** A message at the foot of the page. It stays until its time is up, or until it is closed. */
export function toastView(message, close) {
  return h('div', { class: 'toast-body' },
    h('span', { class: 'toast-text' }, message),
    h('button', {
      type: 'button', class: 'toast-close', title: 'Close', 'aria-label': 'Close', onClick: close,
    }, icon('x', 'is-small')));
}

// Where the scale of a signal reading starts and ends, in dBm.
const SIGNAL_FLOOR = -90;
const SIGNAL_CEILING = -40;
// The bands of signalQuality in core.js, weakest first, with the reading each one starts at.
const SIGNAL_BANDS = [['Weak', SIGNAL_FLOOR], ['Fair', -75], ['Good', -67], ['Excellent', -55]];

function onSignalScale(rssi) {
  const place = (rssi - SIGNAL_FLOOR) / (SIGNAL_CEILING - SIGNAL_FLOOR);
  return `${Math.round(Math.min(1, Math.max(0, place)) * 1000) / 10}%`;
}

/** A reading on the scale of a signal meter: the four bands, and a needle where the board is. */
function signalScale(device) {
  const quality = signalQuality(device.rssi);
  if (!quality) return null;
  return h('div', {
    class: 'signal-scale',
    role: 'img',
    'aria-label': `Wi-Fi signal ${signed(device.rssi)} dBm, ${quality.label.toLowerCase()}`,
  },
  h('div', { class: 'signal-track' },
    SIGNAL_BANDS.map(([label, from], index) => {
      const to = SIGNAL_BANDS[index + 1]?.[1] ?? SIGNAL_CEILING;
      return h('span', {
        key: label,
        class: `signal-band ${label === quality.label ? 'is-here' : ''}`.trim(),
        vars: { '--span': String(to - from) },
      }, h('span', { class: 'signal-band-name' }, label));
    }),
    h('span', { class: 'signal-needle', vars: { '--at': onSignalScale(device.rssi) } })));
}

// What a board's flash holds: the bootloader and the two slots.

/**
 * One row of the flash map. A row only ever fills while bytes are really arriving; a
 * slot that holds an image is said in words, because nothing reports how full it is.
 */
function flashRow(name, { version, none = 'No new image', state, tone = 'idle', iconName = null, receiving = null }) {
  return h('li', {
    key: name,
    class: `flash-row is-${tone} ${receiving === null ? '' : 'is-receiving'}`.trim(),
    vars: receiving === null ? null : { '--fill': `${receiving}%` },
  },
  h('span', { class: 'flash-name' }, name),
  h('span', { class: 'flash-version' }, version ? mono(version) : h('span', { class: 'flash-none' }, none)),
  h('span', { class: 'flash-state' }, iconName ? icon(iconName, 'is-small') : null, h('span', null, state)));
}

const WORKED_OUT = 'Worked out from the step the board last reported.';

function flashMap(title, primary, secondary, { swapping = false, heading = 'h3', note = WORKED_OUT } = {}) {
  return h('section', { class: 'flash', key: 'flash', 'aria-label': title },
    h(heading, { class: 'eyebrow flash-title' }, title),
    h('ul', { class: 'flash-rows' },
      h('li', { key: 'boot', class: 'flash-row is-boot' },
        h('span', { class: 'flash-name' }, 'Bootloader'),
        h('span', { class: 'flash-version' }, mono('MCUboot')),
        h('span', { class: 'flash-state' }, 'Checks every signature')),
      flashRow('Primary slot', primary),
      swapping ? h('li', { key: 'swap', class: 'flash-swap', 'aria-hidden': 'true' }, icon('swap')) : null,
      flashRow('Secondary slot', secondary)),
    h('p', { class: 'flash-note' }, note));
}

const FLASH_NOW = 'Flash memory now';
const FLASH_ENDED = 'Flash memory when this update ended';
const FLASH_SEEN = 'Flash memory when last seen';

// A map of the moment an update ended, for a board whose version then is not on record.
const STAYED_IN_PLACE = { none: 'Previous firmware', state: 'Stayed in place', tone: 'run' };

/**
 * What each slot holds at this point of an update, told from the phase the board last
 * reported. Null where the phase does not say.
 *
 * `description` is what describeExecution() made of the same execution: a cancelled
 * update can end in several ways, and the map says the same as the words above it.
 *
 * A map headed "when this update ended" only ever names what the job recorded then, or
 * no version: what the board reports today is another moment, on a map headed that way.
 */
function slotsOfExecution(execution, known, target, description, deployment) {
  const { phase, ranAtEnd, reported, progress, startedAt, online } = execution;
  // What an offline board last said is not what its flash holds now.
  const flashNow = online ? FLASH_NOW : FLASH_SEEN;
  const latest = reported ?? known?.fw?.version ?? null;
  const previous = latest && latest !== target ? latest : null;
  const stays = {
    version: latest, none: 'Version not reported', state: online ? 'Runs from here, not touched' : 'Ran from here, not touched', tone: 'run',
  };
  const old = { version: previous, none: 'Previous firmware' };
  // A slot at work, or what it was at when a board that has gone offline was last heard of.
  const atWork = (state, was, iconName) => (online ? { state, tone: 'live', iconName } : { state: was, tone: 'idle' });
  const restarting = () => flashMap(flashNow, { ...stays, ...atWork('Being replaced', 'Was being replaced', 'restart') },
    { version: target, ...atWork('Bootloader checks the signature', 'Was with the bootloader', 'shield') }, { swapping: online });
  const onTrial = () => flashMap(flashNow, { version: target, ...atWork('Runs on trial', 'Was on trial', 'pulse') },
    { ...old, state: 'Kept to fall back on' });
  const ranFromHere = { version: ranAtEnd, none: 'Previous firmware', state: 'Ran from here, not touched', tone: 'run' };

  switch (phase) {
    case 'waiting_for_device':
    case 'starting':
      return flashMap(flashNow, stays, { state: 'Nothing written yet' });
    case 'waiting_for_button':
      return flashMap(flashNow, stays, { state: 'Nothing is written until Button 1 is pressed' });
    case 'downloading':
      return flashMap(flashNow, stays, {
        version: target,
        ...atWork('Receiving the image', 'Was receiving the image', 'download'),
        receiving: online ? progress ?? 0 : null,
      });
    case 'verifying':
      return flashMap(flashNow, stays, { version: target, ...atWork('Written, being checked', 'Was being checked', 'shield') });
    case 'rebooting':
      return restarting();
    case 'testing':
      return onTrial();
    case 'succeeded':
      return flashMap(FLASH_ENDED, {
        version: ranAtEnd ?? target, state: 'Ran from here, confirmed', tone: 'good', iconName: 'check',
      }, { none: 'Previous firmware', state: 'No longer needed' });
    case 'rolled_back':
      return flashMap(FLASH_ENDED, { ...ranFromHere, state: 'Put back by the bootloader', tone: 'good', iconName: 'undo' },
        { version: target, state: 'Started but never confirmed', tone: 'bad', iconName: 'x-circle' });
    case 'declined':
    case 'refused':
      return flashMap(FLASH_ENDED, ranFromHere, { state: 'Nothing written' });
    case 'failed':
      return flashMap(FLASH_ENDED, ranFromHere, { version: target, state: 'Not installed', tone: 'bad', iconName: 'x-circle' });
    case 'cancelled': {
      // No job holds what a cancelled board ran. Before it started, it ran what it had before.
      if (!startedAt) return flashMap(FLASH_ENDED, STAYED_IN_PLACE, { state: 'Nothing written' });
      // It had gone too far to be stopped: the new firmware is what the board reports.
      if (description.installed) {
        return flashMap(flashNow, {
          version: target, state: online ? 'Runs from here, confirmed' : 'Ran from here, confirmed', tone: 'good', iconName: 'check',
        }, { none: 'Previous firmware', state: 'No longer needed' });
      }
      const reached = known?.ota?.job === deployment ? known.ota.state : null;
      if (reached === 'rebooting') return restarting();
      if (reached === 'testing') return onTrial();
      // How it ended is not known, so there is no map of that: only the board's latest report.
      if (description.unsure) {
        return flashMap(flashNow, { ...stays, state: online ? 'What the board reports' : 'What the board last reported', iconName: null },
          { none: 'Not reported by the board', state: 'How this update ended is not known' },
          { note: 'A board that AWS has cancelled cannot report the end of that update.' });
      }
      // It stopped there, or another deployment installed it later: when this one ended, the board had not.
      return flashMap(FLASH_ENDED, STAYED_IN_PLACE, { version: target, state: 'Not installed' });
    }
    default:
      return null;
  }
}

/** The same, told from what a board last reported about itself. */
function slotsOfDevice(device) {
  const { fw, ota, online } = device;
  // On a map of when an offline board was last seen, that is over.
  const onTrialWords = online ? 'Runs on trial' : 'Was on trial';
  const confirmedWords = online ? 'Runs from here, confirmed' : 'Ran from here, confirmed';
  const running = {
    version: fw?.version ?? null,
    none: 'Version not reported',
    state: fw?.confirmed ? confirmedWords : fw ? onTrialWords : 'Nothing reported',
    tone: fw?.confirmed ? 'good' : fw ? 'live' : 'idle',
    iconName: fw?.confirmed ? 'check' : fw ? 'pulse' : null,
  };
  const target = versionOfDeployment(ota?.job);
  // The page's title is a level above: a board's page has no other heading in between.
  const options = {
    heading: 'h2',
    note: ota ? WORKED_OUT : 'The board reports what it runs, and nothing about its other slot.',
  };
  const title = online ? FLASH_NOW : FLASH_SEEN;
  if (!ota || ota.state === 'idle') {
    return flashMap(title, running, { none: 'Not reported by the board', state: 'No update under way' }, options);
  }
  if (ota.state === 'awaiting_user') {
    return flashMap(title, running, {
      none: 'Not reported by the board',
      state: online ? 'Nothing is written until Button 1 is pressed' : describeUpdate(device).title,
    }, options);
  }
  if (ota.state === 'testing') {
    return flashMap(title, { ...running, state: onTrialWords, tone: online ? 'live' : 'idle', iconName: 'pulse' },
      { none: 'Previous firmware', state: 'Kept to fall back on' }, options);
  }
  // It went quiet in the middle of this, and may have moved on since: old news is told as old news.
  if (!online) return flashMap(title, running, { version: target, state: describeUpdate(device).title }, options);
  if (ota.state === 'downloading') {
    return flashMap(title, running, {
      version: target, state: 'Receiving the image', tone: 'live', iconName: 'download', receiving: ota.progress ?? 0,
    }, options);
  }
  return flashMap(title, running, { version: target, state: 'Written, being checked', tone: 'live', iconName: 'shield' },
    { ...options, swapping: ota.state === 'rebooting' });
}

// The step indicator for one board's update.

const STEP_STATES = {
  done: { icon: 'check', label: 'done' },
  current: { icon: null, label: 'in progress' },
  failed: { icon: null, label: 'stopped here' },
  // Where a board that was stopped, or went quiet, had got to. Nothing went wrong there.
  stopped: { icon: 'minus', label: 'stopped here' },
  skipped: { icon: null, label: 'not reached' },
  upcoming: { icon: null, label: 'not started' },
  // Nobody can tell from here: a board that AWS has cancelled no longer reports.
  unknown: { icon: 'minus', label: 'not known' },
};
const DOWNLOAD_STEP = 2;
// What each step is drawn with while it is not done: the same order as STEPS in core.js.
const STEP_ICONS = ['send', 'press', 'download', 'shield', 'restart', 'pulse', 'check-circle'];
// Whose turn it is decides what the current step is called.
const CURRENT_WORDS = { act: 'your turn', wait: 'waiting' };

/** Pressing the button is somebody's turn. For a viewer, who cannot deploy either, that is not said to be theirs. */
function currentWord(tone, viewer) {
  return viewer && tone === 'act' ? 'waiting for someone' : CURRENT_WORDS[tone];
}

/** The mark of a step that stopped: the way back for a rollback, otherwise what stopped it. */
function failedMark(description) {
  if (description.icon === 'undo' || description.icon === 'ban') return description.icon;
  return description.tone === 'warn' ? 'minus' : 'x';
}

function stepList(description, { compact = false, preview = false, viewer = false } = {}) {
  const at = description.steps.findIndex((step) => step.state === 'failed');
  const look = `is-${description.tone ?? 'idle'} ${compact ? 'is-compact' : ''} ${preview ? 'is-preview' : ''}`;
  // The mark of a step that failed takes the tone of the headline above it.
  return h('ol', { class: `steps ${look}`.replace(/\s+/g, ' ').trim(), 'aria-label': 'Steps of the update' },
    description.steps.map((step, index) => {
      const state = STEP_STATES[step.state];
      const current = step.state === 'current';
      const failed = step.state === 'failed';
      const downloading = current && index === DOWNLOAD_STEP && description.progress !== null;
      let path = '';
      if (at > 0 && index <= at) {
        path = 'is-on-return';
        if (index === 0) path += ' is-return-start';
        if (index === at) path += ' is-return-end';
      }
      let mark = state.icon ?? STEP_ICONS[index];
      if (failed) mark = failedMark(description);
      return h('li', {
        // By position: what a step is called changes with its state.
        key: String(index),
        class: `step is-${step.state} ${downloading ? 'has-progress' : ''} ${path}`.replace(/\s+/g, ' ').trim(),
        'aria-current': current ? 'step' : null,
        // The rail from this step to the next fills as the image comes in.
        vars: downloading ? { '--progress': `${description.progress}%` } : null,
      },
      h('span', { class: 'step-mark' }, icon(mark)),
      h('span', { class: 'step-label' }, step.label, downloading ? ` ${description.progress}%` : null),
      // A list of what every update goes through has no states to tell.
      preview ? null : h('span', { class: 'sr-only' }, ': '),
      preview
        ? null
        : h('span', { class: 'step-state' }, step.word ?? (current ? currentWord(description.tone, viewer) ?? state.label : state.label)));
    }));
}

/**
 * The way back when an update stops: an arc over the steps, from where it stopped to
 * where it began, with what the board runs now. Nothing to draw if it stopped nowhere
 * in particular.
 */
function returnPath(execution, description) {
  const at = description.steps.findIndex((step) => step.state === 'failed');
  if (at < 1) return null;
  const { phase, ranAtEnd } = execution;
  // What the job recorded when it ended, which says nothing about the board today.
  let words = ['It stayed on the firmware it had', ranAtEnd ? [': ', mono(ranAtEnd)] : null];
  if (phase === 'rolled_back') {
    words = ['It went back to the previous firmware', ranAtEnd ? [': ', mono(ranAtEnd)] : null];
  } else if (phase === 'declined' || phase === 'refused') {
    words = ['Nothing was installed', ranAtEnd ? ['. It stayed on ', mono(ranAtEnd)] : null];
  }
  return h('div', {
    class: `return-path is-${description.tone} ${at < 3 ? 'is-short' : ''}`.trim(),
    key: 'return',
    vars: { '--at': String(at) },
  },
  h('span', { class: 'return-arc', 'aria-hidden': 'true' }),
  h('p', { class: 'return-label' },
    icon('undo'),
    h('span', null, words)));
}

// Sign-in and other moments when there is no console to show.

/** A single message in the middle of the page, with at most one thing to do. */
export function gateView({ iconName = 'lock', title, text, detail, code, action, waiting, leaving }) {
  const moving = waiting || leaving;
  return h('div', { class: `gate ${moving ? 'is-moving' : ''}`.trim() },
    h('div', { class: 'gate-copy' },
      h('div', { class: 'gate-brand' },
        brandMark(),
        h('span', { class: 'gate-brand-text' },
          h('span', { class: 'gate-brand-name' }, 'Cranium'),
          h('span', { class: 'gate-brand-sub' }, 'Firmware console'))),
      h('div', { class: 'gate-message' },
        // The padlock is what every gate has by default; the mark above says as much.
        iconName === 'lock' ? null : h('span', { class: 'gate-icon' }, icon(iconName)),
        h('h1', { class: 'gate-title', id: 'page-title', tabindex: '-1' }, title),
        text ? h('p', { class: 'gate-text' }, text) : null,
        detail ? h('p', { class: 'gate-text' }, detail, code ? [' ', mono(code)] : null) : null,
        action ? button(`is-large ${action.quiet ? '' : 'is-primary'}`.trim(), action.run, action.label) : null),
      h('p', { class: 'gate-foot' }, 'Upload signed firmware, offer it to boards, watch each one update.')),
    h('div', { class: 'gate-art' }, domeArt()));
}

// The masthead: sections and who is signed in.

const SECTIONS = [
  ['overview', 'Overview'],
  ['devices', 'Devices'],
  ['firmware', 'Firmware'],
  ['deployments', 'Deployments'],
  ['activity', 'Activity'],
  ['developer', 'Developer'],
];
const SECTION_OF = { device: 'devices', deployment: 'deployments', serial: 'developer', history: 'developer' };

/** Where Developer leads: a viewer has no use for the serial console's controls. */
function sectionHref(view, ctx) {
  if (view !== 'developer') return `#/${view}`;
  return ctx.state.me?.canWrite === false ? '#/history' : '#/serial';
}

export function navView(ctx) {
  const current = SECTION_OF[ctx.state.route.view] ?? ctx.state.route.view;
  return h('ul', { class: 'nav-list' }, SECTIONS.map(([view, label]) =>
    h('li', { key: view }, h('a', {
      class: 'nav-link',
      href: sectionHref(view, ctx),
      // Keeps the room the name takes in bold, so that the sections stay where they are.
      'data-label': label,
      'aria-current': view === current ? 'page' : null,
    }, label))));
}

// The pages of the Developer section, which have a script each (serial.js, history.js).

export { badge, button, empty, loading, mono, notice, pageHead };

export function developerTabs(current) {
  return h('nav', { class: 'dev-tabs', key: 'tabs', 'aria-label': 'Developer pages' },
    h('span', { class: 'eyebrow' }, 'Developer'),
    [['serial', 'Serial console'], ['history', 'History']].map(([view, label]) => h('a', {
      key: view,
      class: 'nav-link',
      href: `#/${view}`,
      'data-label': label,
      'aria-current': view === current ? 'page' : null,
    }, label)));
}

/** Such a page while its script is on the way, or when it could not be fetched. */
export function scriptPending(ctx, view, title) {
  return h('div', { class: 'page', key: 'page' },
    developerTabs(view),
    pageHead({ title }),
    ctx.state.scriptFailed
      ? notice('bad', 'alert', 'This page could not be loaded. The console may have been updated since ' +
        'this tab was opened: reload to get the new version.', {
        action: button('is-small', () => location.reload(), 'Reload'),
      })
      : loading('the page'));
}

export function accountView(ctx) {
  const { me, sessionLeft } = ctx.state;
  const left = Math.max(0, sessionLeft);
  const ends = new Date(Date.now() + left * 1000);
  const session = left > 0
    ? { title: `You will be asked to sign in again at ${ends.toLocaleTimeString()}.`, text: `Session ends in ${duration(left)}` }
    : { title: 'Sign in again to go on.', text: 'Session ended' };
  const role = me.canWrite ? 'Release manager' : 'Viewer';
  // The account id is what the activity log files this person's actions under.
  const identity = [me.email, me.sub ? `Account ${me.sub}` : ''].filter(Boolean).join(' · ');
  return h('div', { class: 'account-box' },
    h('div', { class: 'account-who' },
      h('span', { class: 'account-email', title: identity || null }, me.email || 'Signed in'),
      h('span', { class: 'account-meta' },
        h('span', { class: 'account-role' }, icon(me.canWrite ? 'key' : 'user', 'is-small'), role),
        h('span', { class: 'account-session', title: session.title }, session.text))),
    button('is-small', ctx.actions.signOut, icon('sign-out'), 'Sign out'));
}

// Overview.

const SCRIPTED_TAG = 'Script, no sign-in';
const SCRIPTED_NOTE = 'Sent by a script (the test bench or scripts/ota.sh) with AWS credentials, directly to the API ' +
  'function. Nobody signed in. The name is the one the script gave, which has to be an active release manager, ' +
  'so the entry does not show that this person did it.';

/** What the tag on such a line means, said once, in words a touch screen can reach. */
function scriptedKey(entries, className) {
  if (!entries.some((entry) => describeAudit(entry).scripted)) return null;
  return h('p', { class: `log-key ${className}`.trim(), key: 'scripted' },
    h('span', { class: 'tag is-warn' }, SCRIPTED_TAG), ` ${SCRIPTED_NOTE}`);
}

/** One entry of the activity log. The short form is for the overview. */
function activityLine(entry, ctx, compact) {
  const description = describeAudit(entry);
  const { actor } = entry;
  const name = nameOf(actor);
  const account = actor?.sub ? `Account ${actor.sub}` : null;
  const outcome = description.outcome
    ? [' ', badge(description.outcome.tone, description.outcome.icon, description.outcome.label)]
    : null;
  // The line says that the deployment was started. How it ended is not in the log, and
  // follows from the deployment as it is now, once it is over.
  const run = entry.action === 'deployment.create' && entry.outcome === 'ok'
    ? (ctx.state.deployments.value ?? []).find((deployment) => deployment.id === entry.target) ?? null
    : null;
  const ending = run && !isUnderWay(run) ? describeDeployment(run) : null;
  return h('li', { key: `${entry.at}-${entry.requestId}`, class: 'log-line' },
    h('span', { class: `log-icon ${description.outcome ? `is-${description.outcome.tone}` : ''}`.trim() },
      icon(description.icon)),
    h('div', { class: 'log-body' },
      h('p', { class: 'log-what' },
        // The whole address, in the short form too: its owner can change it, and the part
        // before the @ alone could be anybody's. The tooltip adds the account.
        h('span', {
          class: 'log-actor',
          title: compact ? [actor?.email, account].filter(Boolean).join(' · ') || null : account,
        }, name),
        ` ${description.verb} `,
        description.label
          ? linkTo(description.href, { class: 'mono log-target' }, description.label)
          : null,
        outcome,
        ending ? [' ', badge(ending.tone, ending.icon, ending.label)] : null,
        description.scripted ? [' ', h('span', { class: 'tag is-warn' }, SCRIPTED_TAG)] : null),
      compact
        ? null
        : h('p', { class: 'log-detail dotted' },
          description.facts.map((fact) => auditFact(fact, ctx)),
          // Two accounts can show the same address, or one that looks the same. The id tells them apart.
          actor?.sub
            ? h('span', { key: 'account', class: 'log-ref', title: account },
              'Account ', mono(shortAccount(actor.sub)))
            : null,
          entry.requestId
            ? h('span', { key: 'request', class: 'log-ref' }, 'Request ', mono(entry.requestId))
            : null)),
    // The full log files its lines under the day, so a line says when in that day.
    h('span', { class: 'log-when' }, compact ? when(entry.at, ctx.state.now) : whenInDay(entry.at)));
}

/** One fact of a log entry. A digest is shortened: the button next to it copies all of it. */
function auditFact(fact, ctx) {
  if (fact.key === 'sha256') {
    return h('span', { key: 'fact-sha256', class: 'digest-row' },
      `${fact.label} `, mono(`${fact.value.slice(0, 12)}…`),
      copyButton(fact.value, `the SHA-256 of ${fact.value.slice(0, 12)}…`, ctx));
  }
  if (fact.words) {
    return h('span', { key: `fact-${fact.key}`, title: `Code ${fact.value}` }, `${fact.words}.`);
  }
  return h('span', { key: `fact-${fact.key}` },
    fact.phrase ? `${fact.label} ` : `${fact.label}: `,
    fact.code ? mono(fact.value) : fact.value);
}

/** The two buttons on the board, while it waits for a person. The words beside it say the same. */
function buttonKeys() {
  return h('div', { class: 'keys', 'aria-hidden': 'true' },
    h('span', { class: 'key is-lit' },
      h('span', { class: 'key-cap' }),
      h('span', { class: 'key-words' }, h('strong', null, 'Button 1'), 'installs')),
    h('span', { class: 'key' },
      h('span', { class: 'key-cap' }),
      h('span', { class: 'key-words' }, h('strong', null, 'Button 2'), 'declines')));
}

/** One board of a deployment that is under way, as a line on the overview. */
function boardLine(execution, deployment, ctx, known) {
  const { now } = ctx.state;
  const description = describeExecution(execution, {
    board: known ?? null, deployment: deployment.id, version: deployment.version, unread: ctx.state.devices.value === null,
  });
  const lastSeen = known?.lastSeen ?? null;
  const offline = !execution.online;
  return h('li', { key: execution.thing, class: `board-run is-${description.tone}` },
    h('div', { class: 'board-run-head' },
      h('div', { class: 'board-run-who' },
        linkTo(deviceHref(execution.thing), { class: 'mono board-run-name', title: execution.thing }, execution.thing),
        h('div', { class: 'board-run-state' },
          description.progress !== null
            ? h('span', { class: `status is-${description.tone}` },
              icon(description.icon),
              h('span', null, description.said ?? description.title,
                h('span', { class: 'said-big' }, ` ${description.progress}%`)))
            : statusLine(description),
          description.progress !== null
            ? meter(description.progress, `Download on ${execution.thing}`)
            : h('span', { class: 'board-run-note' }, prose(description.brief),
              offline && lastSeen ? [' Last seen ', when(lastSeen, now), '.'] : null))),
      description.progress !== null
        ? h('p', { class: 'board-run-figure', 'aria-hidden': 'true' },
          String(description.progress), h('span', { class: 'execution-percent' }, '%'))
        : null,
      description.tone === 'act' ? buttonKeys() : null),
    stepList(description, { compact: true, viewer: !ctx.state.me.canWrite }));
}

function startedBy(deployment, now, stamp = when) {
  return [
    'Started ',
    stamp(deployment.createdAt, now),
    deployment.createdBy ? [' by ', who(deployment.createdBy)] : null,
  ];
}

const NOT_REGISTERED = 'Not a registered release';

/** The list of releases, or null while it has not been read. */
function releaseList(ctx) {
  return ctx.state.firmware.value?.releases ?? null;
}

/** The boards that report a version that is not in the list of releases. */
function offList(devices, ctx) {
  return (devices ?? []).filter((device) => isUnregistered(device.fw?.version, releaseList(ctx)));
}

/** The oldest of what these boards last said. */
function oldestSeen(boards) {
  return boards.reduce((oldest, device) => (Date.parse(device.lastSeen) < Date.parse(oldest.lastSeen) ? device : oldest));
}

/**
 * That what is said of these boards is what they last said, and when, for those that are
 * offline. They are the boards the sentence above this one is about, which may not be all
 * there are. `alone` says that "the board" can only be taken for the one that is meant.
 */
function offlineWords(boards, now, alone = boards.length === 1) {
  const quiet = boards.filter((device) => !device.online && device.lastSeen);
  if (quiet.length === 0) return null;
  const seen = when(oldestSeen(quiet).lastSeen, now);
  if (alone) return ['As last reported: the board is offline, last seen ', seen, '.'];
  if (boards.length === 1) return ['As last reported: that board is offline, last seen ', seen, '.'];
  return quiet.length === 1
    ? ['As last reported: 1 of them is offline, last seen ', seen, '.']
    : [`As last reported: ${quiet.length} of them are offline, the oldest report `, seen, '.'];
}

/** The same in a few words, under a figure that counts boards by what they run. */
function asReported(devices, now) {
  const quiet = devices.filter((device) => device.fw && !device.online && device.lastSeen);
  if (quiet.length === 0) return null;
  const seen = when(oldestSeen(quiet).lastSeen, now);
  return h('p', { class: 'card-note fleet-note', key: 'reported' },
    quiet.length === 1 ? 'As last reported ' : 'As last reported, the oldest ', seen, '.');
}

/** The versions of the releases that are revoked, as far as they are known here. */
function revokedVersions(ctx) {
  const releases = ctx.state.firmware.value?.releases ?? [];
  return new Set(releases.filter((release) => release.status !== 'active').map((release) => release.version));
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
  const list = h('ol', { class: 'guide-steps' },
    step(0, 'Register a board',
      'Each board gets its own certificate and name. With the board connected over USB, run ',
      h('code', { class: 'code' }, 'python3 tools/provision_device.py')),
    canWrite
      ? step(1, 'Upload a signed image',
        'Drop ', mono('binaries/latest.signed.bin'), ' on the ', h('a', { href: '#/firmware' }, 'Firmware'),
        ' page. The server checks its signature before it is stored.')
      : step(1, 'Upload a signed image',
        'A release manager uploads a signed build. ',
        'The server checks its signature before it is stored.'),
    canWrite
      ? step(2, 'Deploy it',
        'Start a deployment on the ', h('a', { href: '#/deployments' }, 'Deployments'),
        ` page. A board on firmware ${FIRST_WITH_NO_BUTTON} or newer installs it by itself; older firmware ` +
        'waits for someone to press Button 1 on the board.')
      : step(2, 'Deploy it',
        `A release manager deploys the release to boards. A board on firmware ${FIRST_WITH_NO_BUTTON} or newer ` +
        'installs it by itself; older firmware waits for someone to press Button 1 on the board.'));
  return card({ key: 'guide', title: 'Getting started', className: 'guide' }, list);
}

/** What every update goes through, for a console that has not seen one yet. */
function updateJourney() {
  const preview = { progress: null, steps: STEPS.map((step) => ({ label: step.name, state: 'upcoming' })) };
  return h('section', { class: 'journey', key: 'journey', 'aria-label': 'The steps of an update' },
    h('div', { class: 'journey-head' },
      h('p', { class: 'journey-title' }, 'What every update goes through'),
      h('p', { class: 'journey-text' },
        'Nothing installs until a release manager deploys it. The board then checks what it received, and ',
        'the bootloader goes back to the previous firmware if the new one cannot reconnect.')),
    stepList(preview, { preview: true }));
}

/** On line and not restarting: a board that said it is restarting is off for the moment. */
function isUp(device) {
  return device.online && !isRestarting(device);
}

/** Boards in the words the tiles draw them in. */
function boardsCounted(devices) {
  const online = devices.filter(isUp).length;
  const quiet = devices.filter((device) => !isUp(device) && device.lastSeen).length;
  const never = devices.length - online - quiet;
  return { online, quiet, never };
}

/** The words next to the tiles, for a fleet of more than one board: one board is said by the figure. */
function tileWords(devices, extra = []) {
  const { online, quiet, never } = boardsCounted(devices);
  return h('p', { class: 'tile-words dotted', key: 'words' },
    online ? h('span', { key: 'online' }, `${online} online`) : null,
    quiet ? h('span', { key: 'quiet' }, `${quiet} offline`) : null,
    never ? h('span', { key: 'never' }, `${never} never connected`) : null,
    extra.filter(([, count]) => count > 0).map(([word, count]) => h('span', { key: word }, `${count} ${word}`)));
}

function fleetFigure(devices) {
  const { online } = boardsCounted(devices);
  return [
    h('p', { class: 'figure', key: 'figure' },
      h('span', { class: 'figure-value' }, String(online)),
      h('span', { class: 'figure-unit' }, ` of ${plural(devices.length, 'board')} online`)),
    devices.length > 1 ? boardTiles(devices) : null,
  ];
}

/** How many boards are online, in the panel at the top of the overview. */
function onlineCard(ctx, devices) {
  let body;
  if (devices === null) {
    body = pending(ctx.state.devices, 'boards');
  } else if (devices.length === 0) {
    body = h('p', { class: 'quiet' }, 'No boards are registered yet.');
  } else {
    body = [fleetFigure(devices), devices.length > 1 ? tileWords(devices) : null];
  }
  return card({ key: 'online', title: 'Fleet', className: 'is-zone' }, body);
}

// More than this, and the card sends the reader to the page that has them all.
const BOARDS_SHOWN = 6;

function boardsCard(ctx, devices) {
  const { state } = ctx;
  let body;
  if (devices === null) {
    body = pending(state.devices, 'boards');
  } else if (devices.length === 0) {
    body = h('p', { class: 'quiet' }, 'Boards appear here once they are registered.');
  } else {
    const head = h('li', { key: 'head', class: 'board-head', 'aria-hidden': 'true' },
      h('span', null, 'Board'), h('span', null, 'Firmware'), h('span', null, 'Signal'), h('span', null, 'Update'));
    body = [
      h('ul', { class: 'board-list', key: 'list' }, head, devices.slice(0, BOARDS_SHOWN).map((device) => {
        const reported = describeUpdate(device);
        // The panel above and this row say one percentage: the board list is read less often.
        const own = state.deploymentDetails.get(device.ota?.job)?.value?.executions
          .find((execution) => execution.thing === device.thing);
        const progress = reported.progress !== null && own?.phase === 'downloading' && own.progress !== null
          ? own.progress
          : reported.progress;
        // A row among rows: the panel above is what asks somebody to press a button.
        const update = reported.tone === 'act'
          ? { ...reported, tone: 'wait', title: 'Waiting for its button' }
          : { ...reported, progress };
        const seen = heartbeatWords(device, state.now) ?? 'Never connected';
        return h('li', { key: device.thing, class: 'board-line' },
          h('span', { class: `presence-dot ${isUp(device) ? 'is-on' : ''}`.trim() }),
          h('span', { class: 'board-line-who' },
            linkTo(deviceHref(device.thing), { class: 'mono board-line-name', title: device.thing }, device.thing),
            h('span', { class: 'board-line-note' }, seen)),
          h('span', { class: 'board-line-fw' },
            device.fw
              ? [mono(device.fw.version),
                device.fw.confirmed
                  ? h('span', { class: 'board-line-mark', title: 'Confirmed' }, icon('check', 'is-small'), h('span', { class: 'sr-only' }, ' confirmed'))
                  : h('span', { class: 'tag is-warn' }, 'On trial'),
                isUnregistered(device.fw.version, releaseList(ctx))
                  ? h('span', { class: 'tag is-warn' }, NOT_REGISTERED)
                  : null]
              : h('span', { class: 'quiet' }, 'Not reported')),
          h('span', { class: 'board-line-signal' }, signalWords(device, (quality) => [signalBars(quality), quality.label])),
          h('span', { class: 'board-line-update' },
            statusLine(update, update.progress !== null ? h('span', { class: 'status-value' }, `${update.progress}%`) : null)));
      })),
      devices.length > BOARDS_SHOWN
        ? h('p', { class: 'card-note board-more', key: 'more' },
          h('a', { href: '#/devices' }, `and ${plural(devices.length - BOARDS_SHOWN, 'more board')}`))
        : null,
    ];
  }
  return card({
    key: 'boards',
    title: 'Boards',
    className: 'overview-boards',
    more: { href: '#/devices', label: 'All devices' },
  }, body);
}

/** The boards by the version they report: newest first, boards that have not said last. */
function versionGroups(devices) {
  const groups = new Map();
  for (const device of devices ?? []) {
    const version = device.fw?.version ?? '';
    groups.set(version, (groups.get(version) ?? []).concat(device));
  }
  const versions = [...groups.keys()].sort((a, b) => {
    if (a === '' || b === '') return a === '' ? 1 : -1;
    return compareVersions(parseVersion(b), parseVersion(a));
  });
  return versions.map((version) => ({ version, members: groups.get(version) }));
}

const OLDER_SHADES = 3;

/**
 * The fleet by firmware: a row per version with one tile per board. Rows label themselves,
 * so one board is a tile, not a bar that fills the width to say "1".
 */
function versionRows(devices, newest, revokedOnes, releases) {
  let behind = 0;
  // One board is said by the row: a tile on its own would measure nothing.
  const tiled = devices.length > 1;
  return h('ul', { class: 'fleet-list', key: 'versions' }, versionGroups(devices).map(({ version, members }) => {
    let tone = 'none';
    const unregistered = isUnregistered(version, releases);
    if (version && version === newest?.version) {
      tone = 'newest';
    } else if (unregistered) {
      tone = 'unregistered';
    } else if (version) {
      behind = Math.min(behind + 1, OLDER_SHADES);
      tone = `older-${behind}`;
    }
    const onTrial = members.filter((device) => device.fw && !device.fw.confirmed).length;
    return h('li', { key: version || 'none', class: 'fleet-line' },
      h('span', { class: 'fleet-name' },
        version ? mono(version, 'fleet-version') : h('span', { class: 'fleet-version quiet' }, 'Not reported'),
        version && newest?.version === version ? h('span', { class: 'tag' }, 'Newest release') : null,
        unregistered ? h('span', { class: 'tag is-warn' }, NOT_REGISTERED) : null,
        onTrial > 0 ? h('span', { class: 'tag is-warn' }, `${onTrial} on trial`) : null),
      h('span', { class: 'fleet-count' }, plural(members.length, 'board'),
        revokedOnes.has(version) ? h('span', { class: 'tag is-bad' }, 'Revoked release') : null),
      tiled
        ? h('span', { class: 'tiles', 'aria-hidden': 'true' }, members.map((device) =>
          h('span', { key: device.thing, class: `tile is-${tone}`, title: device.thing })))
        : null);
  }));
}

function fleetCard(ctx, devices, newest) {
  const groups = versionGroups(devices);
  let body;
  if (devices === null) {
    body = pending(ctx.state.devices, 'versions');
  } else if (groups.length === 0) {
    body = h('p', { class: 'quiet' }, 'Versions appear here once a board has reported.');
  } else {
    const current = groups.find(({ version }) => version && version === newest?.version)?.members.length ?? 0;
    const others = offList(devices, ctx).length;
    // None on the newest release because they are on something that is not a release at
    // all is not the same as being behind, and must not read as that.
    const figure = current === 0 && others > 0
      ? [others, ` of ${devices.length} on firmware that is not a registered release`]
      : [current, ` of ${devices.length} on the newest release`];
    let headline = null;
    if (newest) {
      headline = h('p', { class: 'figure fleet-headline', key: 'headline' },
        h('span', { class: 'figure-value' }, String(figure[0])),
        h('span', { class: 'figure-unit' }, figure[1]));
    } else if (ctx.state.firmware.value) {
      headline = h('p', { class: 'fleet-headline', key: 'headline' }, 'No release can be deployed.');
    }
    body = [
      headline,
      asReported(devices, ctx.state.now),
      versionRows(devices, newest, revokedVersions(ctx), releaseList(ctx)),
    ];
  }
  return card({
    key: 'fleet',
    title: 'Firmware in the fleet',
    className: 'is-zone',
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
  const unused = firmware && (newest ?? firmware.releases[0])
    ? unusedReleaseWords(newest ?? firmware.releases[0], state.devices.value?.devices)
    : null;
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
      unused ? h('p', { class: 'card-note', key: 'unused' }, unused) : null,
    ];
  }
  return card({
    key: 'release',
    title: 'Newest release',
    className: 'is-zone',
    more: { href: '#/firmware', label: 'Firmware' },
  }, body);
}

/**
 * The newest release is what could be deployed, which need not be what the boards run. Said
 * when no board that has reported runs it, so that the two versions on a page do not look like
 * a contradiction.
 */
function unusedReleaseWords(release, devices) {
  const reporting = (devices ?? []).filter((device) => device.fw);
  if (reporting.length === 0 || reporting.some((device) => device.fw.version === release.version)) return null;
  if (reporting.length > 1) return 'No board runs this release.';
  const [board] = reporting;
  return ['The board ', board.online ? 'runs ' : 'last reported ', mono(board.fw.version), ', not this release.'];
}

/** The headline for boards that run something that is not a release. */
function unregisteredWords(strangers, devices) {
  const heard = strangers.every((device) => device.online);
  if (devices.length === 1) {
    const [{ fw }] = strangers;
    return `The board ${heard ? 'runs' : 'last reported'} ${fw.version}, which is not a registered release.`;
  }
  const count = strangers.length;
  if (!heard) return `${plural(count, 'board')} last reported firmware that is not a registered release.`;
  return `${plural(count, 'board runs', 'boards run')} firmware that is not a registered release.`;
}

/** Boards that left what the last deployment installed. How they got there is not on record. */
function movedWords(standing, deployment, now) {
  const { moved } = standing;
  if (deployment.things.length > 1) {
    return `${moved.length} of ${deployment.things.length} boards ${moved.length === 1 ? 'has' : 'have'} moved to other firmware since.`;
  }
  const [board] = moved;
  return board.online
    ? ['The board has since moved to ', mono(board.fw.version), '.']
    : ['When last seen, ', when(board.lastSeen, now), ', the board had moved to ', mono(board.fw.version), '.'];
}

/**
 * Boards that report an update, for when no deployment of this console is under way: a job
 * made directly in AWS IoT is not among the deployments. A board names a job of this console
 * by its id, and any other job as none. An offline board only says what it was at, then.
 */
function workWords(devices) {
  const busy = devices.filter((device) => device.ota && device.ota.state !== 'idle');
  if (busy.length === 0) return null;
  const count = busy.length;
  const alone = devices.length === 1;
  const heard = busy.every((device) => device.online);
  const opening = heard ? '' : 'When last seen, ';
  const who = alone ? `${heard ? 'The' : 'the'} board` : plural(count, 'board');
  const update = count === 1 ? 'an update' : 'updates';
  if (busy.every((device) => device.ota.job === null)) {
    const verb = count === 1 ? (heard ? 'is' : 'was') : (heard ? 'are' : 'were');
    return `${opening}${who} ${verb} working on ${update} that this console did not start.`;
  }
  if (!heard) return `${opening}${who} reported ${update} in progress.`;
  return `${who} ${count === 1 ? 'reports' : 'report'} ${update} in progress.`;
}

function updatesCard(ctx, devices) {
  const { state } = ctx;
  const { now } = state;
  const deployments = state.deployments.value;
  const byThing = new Map((devices ?? []).map((device) => [device.thing, device]));
  // Decided by the boards, not by the status of the job: a cancelled deployment can
  // still have a board that is installing, or restarting into the new firmware.
  const active = (deployments ?? []).filter((deployment) =>
    isUnderWay(deployment) || stillFinishing(deployment, devices, now));
  const lastDone = (deployments ?? []).find((deployment) => !active.includes(deployment)) ?? null;
  // What is on the page predates the failure: it cannot say that nothing is going on.
  const outOfDate = Boolean(state.deployments.error);

  let body;
  if (deployments === null) {
    body = pending(state.deployments, 'deployments');
  } else if (active.length === 0 && devices === null && !state.devices.error) {
    // That nothing is going on is for the boards to say as well, and they are on their way.
    body = pending(state.devices, 'boards');
  } else if (active.length === 0) {
    // The tick is for updates that have been through, and only for those: a page that
    // says all is well right after a rollout failed would mislead at a glance. A
    // deployment that went wrong is what the panel opens with, in words, an icon and its
    // outcome bar. Before the first deployment there is nothing to tick off.
    const ending = lastDone ? describeDeployment(lastDone, devices) : null;
    // That a deployment went through is on record. Whether that is still what the boards run
    // is for the boards to say, and an offline board can only say what it last reported.
    const standing = ending?.tone === 'good' ? installStanding(lastDone, devices) : null;
    const strangers = offList(devices, ctx);
    const movedOn = standing?.state === 'moved';
    // A board on firmware that is not a release is what there is to tell, unless the last
    // deployment went wrong or is what the boards report right now.
    const offRecord = !outOfDate && strangers.length > 0 &&
      ending?.tone !== 'bad' && ending?.tone !== 'warn' && standing?.state !== 'current';
    // The deployments do not hold a job that was made directly in AWS IoT. The boards tell.
    const work = state.devices.error ? null : workWords(devices);

    let tone = outOfDate ? 'idle' : ending?.tone ?? 'idle';
    let news = outOfDate ? null : ending?.said ?? null;
    if (offRecord) {
      tone = 'warn';
      news = unregisteredWords(strangers, devices);
    } else if (movedOn) {
      // Nothing to tick off: the boards have left what that deployment installed.
      tone = 'idle';
      news = null;
    }
    let iconName = ending?.icon;
    if (tone === 'idle') iconName = news === null && work ? 'restart' : 'minus-circle';
    else if (offRecord) iconName = 'alert';
    // Called off or one board's result: the words say it. A bar that is one block across
    // measures nothing, so it is for what several boards did.
    const boards = lastDone?.things.length ?? 0;
    const showBar = boards > 1 && (tone === 'bad' || tone === 'warn' || tone === 'good');
    // Neither list can say that nothing is going on while it could not be read.
    const unknown = outOfDate || Boolean(state.devices.error);
    const atRest = !unknown && !work;
    const resting = unknown ? 'Whether an update is in progress cannot be told right now.' : 'No update is in progress.';
    let since = null;
    // The headline is about these boards, so the note is too, whatever the last deployment did.
    if (offRecord) since = offlineWords(strangers, now, devices.length === 1);
    else if (!outOfDate && movedOn) since = movedWords(standing, lastDone, now);
    else if (!outOfDate && standing && standing.state !== 'current') since = offlineWords(standing.boards, now);
    body = h('div', { class: `calm is-${tone}` },
      h('p', { class: `calm-title is-${tone}` }, icon(iconName ?? 'minus-circle'), news ?? work ?? resting),
      lastDone
        ? h('p', { class: 'card-note calm-note' },
          // Off the record, what the board runs did not come from a deployment: say whose this is.
          offRecord ? 'Last deployment from this console: ' : (news ? null : 'Last deployment: '),
          linkTo(deploymentHref(lastDone.id), { class: 'mono' }, lastDone.version ?? lastDone.id),
          ' ', badge(ending.tone, ending.icon, ending.label), ' ',
          h('span', null,
            // A cancelled deployment has no end on record: say that the time is its start.
            lastDone.completedAt
              ? when(lastDone.completedAt, now)
              : when(lastDone.createdAt, now, 'started '),
            news && atRest ? '. No update is in progress.' : null))
        : h('p', { class: 'card-note' },
          news && atRest ? 'No update is in progress. ' : null, 'Deployments from this console appear here while boards are being updated.'),
      news && work ? h('p', { class: 'card-note calm-work', key: 'work' }, work) : null,
      since ? h('p', { class: 'card-note calm-since', key: 'since' }, since) : null,
      showBar
        ? h('div', { class: 'calm-outcome' },
          segments(countParts(lastDone.counts), `Boards: ${countWords(lastDone.counts)}.`, { thin: true }),
          // One board's count says what the words above say already.
          boards > 1 ? countList(lastDone.counts) : null)
        : null);
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
            isUnderWay(deployment)
              ? 'This deployment was cancelled. A board that had already started carries on unless it is stopped.'
              : 'This deployment was cancelled, but a board was already restarting into the new firmware. That cannot be stopped.')
          : null,
        detail
          ? h('ul', { class: 'board-runs' }, detail.executions.map((execution) =>
            boardLine(execution, deployment, ctx, byThing.get(execution.thing))))
          : h('p', { class: 'card-note' }, counted.join(', ')));
    }));
  }
  return card({
    key: 'updates',
    title: active.length > 0 ? 'Updates in progress' : 'Updates',
    className: `is-zone updates overview-updates ${active.length > 0 ? 'is-active' : ''}`.trim(),
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
    const shown = recent.slice(0, 5);
    body = [
      h('ul', { class: 'log is-compact', key: 'log' }, shown.map((entry) => activityLine(entry, ctx, true))),
      scriptedKey(shown, 'is-below'),
    ];
  }
  return card({
    key: 'activity',
    title: 'Recent activity',
    className: 'overview-activity',
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

/** A page is only as fresh as the oldest thing on it that could not be read again. */
function oldestRead(resources) {
  const read = resources.filter((resource) => resource.loadedAt > 0);
  return read.reduce((oldest, resource) => (resource.loadedAt < oldest.loadedAt ? resource : oldest), read[0] ?? null);
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
  // A list that could not be read again may be missing what would finish the steps.
  const failed = [state.devices, state.firmware, state.deployments].filter((resource) => resource.error);

  let cards = null;
  if (!blank) {
    cards = [
      h('div', { class: 'panel on-ink overview-panel', key: 'panel' },
        updatesCard(ctx, devices),
        h('div', { class: 'fleet' },
          onlineCard(ctx, devices), fleetCard(ctx, devices, newest), releaseCard(ctx, newest))),
      h('div', { class: 'overview', key: 'grid' }, boardsCard(ctx, devices), activityCard(ctx)),
    ];
  } else if (recorded) {
    cards = activityCard(ctx);
  }

  return h('div', { class: 'page' },
    pageHead({
      title: 'Overview',
      lede: 'What the boards last reported, and what is being updated right now.',
      tools: freshness(oldestRead(failed) ?? state.devices, ctx),
    }),
    loadProblems([
      [state.devices, 'the boards'],
      [state.firmware, 'the releases'],
      [state.deployments, 'the deployments'],
      [state.recent, 'the activity log'],
    ], ctx),
    openRevocations(ctx, firmware),
    loaded && !started && failed.length === 0
      ? h('div', { class: `welcome ${blank ? 'panel on-ink' : ''}`.trim(), key: 'welcome' },
        blank ? archWatermark() : null,
        gettingStarted(ctx, have))
      : null,
    blank ? updateJourney() : null,
    cards);
}

// Devices.

/** Said after a value that an offline board reported. */
function whenLastSeen(device) {
  return device.online ? null : h('span', { class: 'quiet' }, ' when last seen');
}

function firmwareFact(device, revokedOnes, releases) {
  if (!device.fw) return h('span', { class: 'quiet' }, 'Not reported');
  return [
    mono(device.fw.version, 'fact-strong device-version'),
    // Said of the version and of whether it was confirmed. Whether it is a registered
    // release is a fact about today's list of releases.
    whenLastSeen(device),
    device.fw.confirmed
      ? badge('good', 'check', 'Confirmed')
      : badge('warn', 'pulse', 'On trial',
        'Not confirmed yet. The bootloader goes back to the previous firmware if the board ' +
        'restarts before it confirms.'),
    isUnregistered(device.fw.version, releases) ? badge('warn', 'alert', NOT_REGISTERED) : null,
    // Revoking does not touch a board that runs the release.
    revokedOnes.has(device.fw.version)
      ? [
        badge('bad', 'ban', 'Revoked release'),
        factNote('To replace it, upload a newer version and deploy that.'),
      ]
      : null,
  ];
}

/** `offer` is an update this board is offered and that it has not said anything about yet. */
function updateFact(device, offer) {
  const update = describeUpdate(device);
  const percent = update.progress !== null
    ? h('span', { class: 'status-value' }, `${update.progress}%`)
    : null;
  return h('div', { class: 'fact-stack' },
    statusLine(update, percent),
    update.progress !== null ? meter(update.progress, `Download on ${device.thing}`) : null,
    update.text ? factNote(prose(update.text)) : null,
    offer && !update.deployment
      ? factNote([
        'Offered ', offer.version ? mono(offer.version) : 'an update',
        device.online ? '. It has not picked the offer up yet.' : '. It will see the offer when it connects.',
      ])
      : null,
    update.deployment || offer
      ? linkTo(deploymentHref(update.deployment ?? offer.deployment), { class: 'fact-link' },
        'Open the deployment', icon('arrow-right', 'is-small'))
      : null);
}

/**
 * A board's signal as words and bars. An offline board has no signal to speak of, only the
 * reading it last gave: that is what it is called, in muted type, with no verdict on it.
 */
function signalWords(device, live) {
  const quality = signalQuality(device.rssi);
  if (!quality) return h('span', { class: 'quiet' }, 'Not reported');
  if (device.online) return live(quality);
  return [signalBars(quality, true), h('span', { class: 'quiet signal-old' }, `${signed(device.rssi)} dBm when last seen`)];
}

function signalFact(device, withScale) {
  return [
    h('span', { class: 'signal-fact' },
      signalWords(device, (quality) => [signalBars(quality), `${quality.label} · ${signed(device.rssi)} dBm`])),
    // A needle says where the signal is now. There is no such thing for an offline board.
    withScale && device.online ? signalScale(device) : null,
  ];
}

function uptimeFact(device) {
  if (device.uptime === null) return h('span', { class: 'quiet' }, 'Not reported');
  return [duration(device.uptime), whenLastSeen(device)];
}

/** When the last heartbeat arrived. The state goes with it in the words above, or in the badge. */
function heartbeatFact(device, now) {
  return device.lastSeen ? when(device.lastSeen, now) : h('span', { class: 'quiet' }, 'None yet');
}

function deviceFacts(device, ctx, { offer = openOffer(device, ctx), withScale = false, withHeartbeat = false } = {}) {
  return facts([
    // The list of devices has it in the line under the board's name, and its columns are fixed.
    withHeartbeat ? ['Heartbeat', heartbeatFact(device, ctx.state.now)] : null,
    ['Firmware', firmwareFact(device, revokedVersions(ctx), releaseList(ctx))],
    ['Update', updateFact(device, offer)],
    ['Signal', signalFact(device, withScale)],
    ['Uptime', uptimeFact(device)],
  ]);
}

/**
 * The deployment that is waiting for a board, from the deployments whose record has been
 * read. What a board says only goes as far as its last report; an offline board cannot
 * have said anything about an offer made since.
 */
function openOffer(device, ctx) {
  for (const deployment of ctx.state.deployments.value ?? []) {
    const detail = ctx.state.deploymentDetails.get(deployment.id)?.value;
    if (!isUnderWay(deployment) || !detail) continue;
    const own = detail.executions.find((execution) => execution.thing === device.thing);
    if (own?.status === 'QUEUED') return { deployment: deployment.id, version: deployment.version };
  }
  return null;
}

const NEVER_REPORTED = 'Has not reported to AWS IoT yet.';
const NEVER_REPORTED_HELP = 'Power it up and check that it was provisioned.';

function seenLine(device, now) {
  return heartbeatWords(device, now) ?? NEVER_REPORTED;
}

/** The state of the fleet as a whole, at the top of the Devices page. */
function devicesPanel(devices, ctx) {
  const firmware = ctx.state.firmware.value;
  const onTrial = devices.filter((device) => device.fw && !device.fw.confirmed).length;
  const updating = devices.filter((device) => deviceActivity(device) !== null).length;
  // The newest is marked once the releases are known.
  const newest = firmware?.releases.find((release) => release.status === 'active') ?? null;
  return h('section', { class: 'panel on-ink devices-panel', key: 'panel', 'aria-label': 'The fleet at a glance' },
    h('div', { class: 'devices-figure' },
      h('h2', { class: 'eyebrow' }, 'Fleet'),
      fleetFigure(devices),
      devices.length > 1 ? tileWords(devices, [['updating now', updating], ['on trial', onTrial]]) : null),
    h('div', { class: 'devices-versions' },
      h('h2', { class: 'eyebrow' }, 'Firmware in the fleet'),
      asReported(devices, ctx.state.now),
      versionRows(devices, newest, revokedVersions(ctx), releaseList(ctx))));
}

const DEVICE_COLUMNS = ['Board', 'Status', 'Firmware', 'Update', 'Signal', 'Uptime'];

export function devicesView(ctx) {
  const { state } = ctx;
  const devices = state.devices.value?.devices ?? null;
  let body;
  if (devices === null) {
    body = pending(state.devices, 'boards');
  } else if (devices.length === 0) {
    body = card({ key: 'none' }, empty(NO_BOARDS));
  } else {
    body = [
      devicesPanel(devices, ctx),
      h('div', { class: 'device-grid', key: 'grid' },
        h('div', { class: 'device-columns', key: 'columns', 'aria-hidden': 'true' },
          DEVICE_COLUMNS.map((name) => h('span', { key: name }, name))),
        devices.map((device) =>
          h('article', { key: device.thing, class: 'card device' },
            h('header', { class: 'device-head' },
              h('div', null,
                h('h2', { class: 'device-name' },
                  linkTo(deviceHref(device.thing), { class: 'mono cover-link' }, device.thing),
                  icon('arrow-right', 'is-small')),
                h('p', { class: 'device-seen' }, seenLine(device, state.now)),
                device.lastSeen || device.online ? null : h('p', { class: 'device-help' }, NEVER_REPORTED_HELP)),
              presence(device, state.now)),
            deviceFacts(device, ctx)))),
    ];
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

function historyRow(execution, now, last) {
  const version = execution.version ?? versionOfDeployment(execution.deployment);
  // Only a job with this console's kind of name has a page here. Any other was made some
  // other way, directly in AWS IoT, and all this console knows of it is this line.
  const href = deploymentHref(execution.deployment);
  return h('li', { key: execution.deployment, class: 'row history-row' },
    h('div', { class: 'row-main' },
      linkTo(href, { class: `mono row-title ${href ? 'cover-link' : ''}`.trim() },
        version ?? execution.deployment),
      h('span', { class: 'row-note' },
        'Offered ', when(execution.queuedAt, now),
        isUnfinished(execution.status) ? null : [' · ended ', when(execution.lastUpdatedAt, now)]),
      href ? null : h('span', { class: 'row-note history-outside' }, 'Started outside this console')),
    statusLine(describeHistory(execution.status, last)),
    href ? h('span', { class: 'row-chevron' }, icon('arrow-right')) : null);
}

/** The entry of a board's history that the board's own last report speaks of: the one that ended last. */
function newestEnded(executions) {
  const ended = executions.filter((execution) => !isUnfinished(execution.status));
  return ended.reduce((newest, execution) =>
    (Date.parse(execution.lastUpdatedAt) > Date.parse(newest.lastUpdatedAt) ? execution : newest), ended[0] ?? null);
}

/**
 * What matters most on a board's page, on its panel: what the board is doing, if it is
 * doing anything, in words for across a room and with the keys while it waits for a
 * person. Below that, what its flash holds. Nothing on it claims a report that never came.
 */
function boardPanel(device) {
  const heard = device.fw || device.ota;
  const update = describeUpdate(device);
  const working = device.ota && device.ota.state !== 'idle';
  return h('section', { class: 'panel on-ink board-panel', key: 'flash', 'aria-label': 'What the board reports' },
    working
      ? h('div', { class: `board-run board-now is-${update.tone}`, key: 'now' },
        h('div', { class: 'board-run-head' },
          h('div', { class: 'board-run-who' },
            h('div', { class: 'board-run-state' },
              h('span', { class: `status is-${update.tone}` },
                icon(update.icon),
                h('span', null, update.title,
                  update.progress !== null ? h('span', { class: 'said-big' }, ` ${update.progress}%`) : null)),
              update.text ? h('span', { class: 'board-run-note' }, prose(update.text)) : null)),
          update.progress !== null
            ? h('p', { class: 'board-run-figure', 'aria-hidden': 'true' },
              String(update.progress), h('span', { class: 'execution-percent' }, '%'))
            : null,
          update.tone === 'act' ? buttonKeys() : null))
      : null,
    heard
      ? slotsOfDevice(device)
      : h('div', { class: 'board-silent', key: 'silent' },
        h('p', { class: 'board-silent-title' }, icon('minus-circle'), 'Nothing reported yet'),
        h('p', { class: 'board-silent-text' },
          device.lastSeen
            ? 'This board has not said what it runs, so nothing is known about its flash memory.'
            : 'This board has not reported to AWS IoT, so nothing is known about its flash memory.')));
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
    lede: detail
      ? [seenLine(detail.device, state.now), detail.device.lastSeen || detail.device.online ? null : ` ${NEVER_REPORTED_HELP}`]
      : null,
    tools: missing(resource) ? null : freshness(resource, ctx),
  });
  if (missing(resource)) {
    return h('div', { class: 'page' },
      head,
      card({ key: 'none' }, empty({
        iconName: 'chip',
        title: 'No board with this name is registered.',
        text: 'Check the address, or find the board in the list of devices.',
        action: { href: '#/devices', label: 'All devices' },
      })));
  }
  if (!detail) {
    return h('div', { class: 'page is-board' },
      head, loadProblem(resource, 'this board', ctx), pending(resource, 'the board'));
  }

  const { device, certificates, executions, olderExecutions: older } = detail;
  const ended = newestEnded(executions);
  // The board's own history says whether it has an update waiting, without any other list.
  const queued = executions.find((execution) => execution.status === 'QUEUED') ?? null;
  const offer = queued
    ? { deployment: queued.deployment, version: queued.version ?? versionOfDeployment(queued.deployment) }
    : openOffer(device, ctx);
  return h('div', { class: 'page is-board' },
    head,
    loadProblem(resource, 'this board', ctx),
    boardPanel(device),
    h('div', { class: 'split', key: 'split' },
      card({ key: 'state', title: 'State', className: 'device' },
        h('div', { class: 'device-presence' }, presence(device, state.now)),
        deviceFacts(device, ctx, { offer, withScale: true, withHeartbeat: true })),
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
            : [
              h('ul', { class: 'rows', key: 'rows' }, executions.map((execution) =>
                historyRow(execution, state.now, execution === ended ? device.ota?.last ?? null : null))),
              older > 0
                ? h('p', { class: 'card-note history-cut', key: 'cut' },
                  `The newest ${executions.length} are shown. ${plural(older, 'older update is', 'older updates are')} not listed.`)
                : null,
            ]))));
}

// Firmware.

const CHAIN = [
  ['key', 'Signed at build', 'With the project’s private key'],
  ['shield', 'Checked on upload', 'By this server, with the public key'],
  ['chip', 'Checked at boot', 'By the board’s bootloader'],
];

/** A release whose image was checked against a key that is not this project's current one. */
function signedWithOldKey(release, fingerprint) {
  return Boolean(fingerprint) && Boolean(release.keyHash) && release.keyHash !== fingerprint;
}

function trustPanel(ctx) {
  const fingerprint = ctx.state.firmware.value?.fingerprint ?? '';
  // An image is stored only if it checks out against the key the server holds at that
  // moment, so a stored image with another fingerprint is from before the key was replaced.
  const earlier = (ctx.state.firmware.value?.releases ?? []).filter((release) => signedWithOldKey(release, fingerprint)).length;
  return h('div', { class: 'trust' },
    h('h2', { class: 'trust-title' }, icon('shield'), 'The server verifies every upload'),
    h('ol', { class: 'chain', key: 'chain' }, CHAIN.map(([iconName, title, text]) =>
      h('li', { key: title, class: 'chain-link' },
        h('span', { class: 'chain-mark' }, icon(iconName)),
        h('span', { class: 'chain-title' }, title),
        h('span', { class: 'chain-text' }, text)))),
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
          mono(fingerprint, 'digest'), copyButton(fingerprint, 'the key fingerprint', ctx)),
        earlier > 0
          ? h('p', { class: 'fingerprint-note' },
            `${plural(earlier, 'older release was', 'older releases were')} signed with an earlier key, which has been `,
            `replaced since, so ${earlier === 1 ? 'it shows' : 'they show'} another fingerprint.`)
          : null)
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
  h('span', { class: 'drop-title' }, 'Drop ', mono('latest.signed.bin'), ' here'),
  h('span', { class: 'drop-or' }, 'or ', h('span', { class: 'drop-pick' }, 'choose a file')),
  h('span', { class: 'drop-note' },
    slot ? `A signed MCUboot image, up to ${fileSize(slot)}. ` : 'A signed MCUboot image. ',
    'Nothing is sent until you have checked what the file contains.'),
  h('span', { class: 'drop-note drop-where' },
    'Each build leaves its signed image in ', mono('binaries/latest.signed.bin'), ' in your checkout. Git does not track that folder.'));
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

/** False once the release that was just uploaded has been revoked, here or elsewhere. */
function stillRegistered(ctx) {
  const { version } = ctx.state.upload.release;
  const known = ctx.state.firmware.value?.releases.find((release) => release.version === version);
  return !known || known.status === 'active';
}

/**
 * The server looked at this file and said no, and the file is what it said no to. It says
 * so before it has stored anything: a refusal of the file itself is final. A 401 or a 403
 * refuses the account, and whatever else comes back may be tried again.
 */
function refusedForGood(upload) {
  return upload.stage === 'refused' && !canRetryUpload(upload.error) &&
    upload.error.status !== 401 && upload.error.status !== 403;
}

/** The newest deployment of the release that was just uploaded, once there is one. */
function deployedAlready(ctx) {
  const { version } = ctx.state.upload.release;
  return (ctx.state.deployments.value ?? []).find((deployment) => deployment.version === version) ?? null;
}

/** A size in bytes, and in larger units where that says something else. */
function sizeWords(bytes) {
  const short = fileSize(bytes);
  return short === exactBytes(bytes) ? short : `${exactBytes(bytes)} (${short})`;
}

/**
 * Where a file stands on its way to the boards. The strip above the panel: a word and a
 * mark for each stage, so that it reads without its colours.
 */
function uploadStages(ctx) {
  const { upload } = ctx.state;
  const finished = upload.stage === 'done' && stillRegistered(ctx);
  const review = upload.stage === 'ready' ? reviewImage(upload, ctx.state.firmware.value) : null;
  const unusable = Boolean(review?.blocked || review?.doomed);
  const sentOff = ['sending', 'checking', 'refused'].includes(upload.stage) || finished;

  // Finished steps stay in ink. Green is for the one result that was proved here.
  const choose = sentOff
    ? { state: 'done', word: 'done' }
    : { state: unusable ? 'failed' : 'act', word: unusable ? 'cannot be used' : 'your turn' };
  let verify = { state: 'ahead', word: 'not started' };
  if (upload.stage === 'sending') verify = { state: 'live', word: 'uploading' };
  else if (upload.stage === 'checking') verify = { state: 'live', word: 'the server is verifying' };
  else if (finished) verify = { state: 'good', word: 'signature valid' };
  else if (refusedForGood(upload)) verify = { state: 'failed', word: 'refused, nothing stored' };
  else if (upload.stage === 'refused') verify = { state: 'failed', word: 'not finished' };
  let deploy = finished ? { state: 'act', word: 'your turn' } : { state: 'ahead', word: 'not started' };
  if (finished && deployedAlready(ctx)) deploy = { state: 'done', word: 'started' };

  const marks = { done: 'check', good: 'check', failed: 'x' };
  const stages = [
    ['Choose a signed image', choose], ['The server verifies it', verify], ['Deploy it to boards', deploy],
  ];
  return h('ol', { class: 'upload-stages', 'aria-label': 'From a file to the boards' },
    stages.map(([label, { state, word }], index) => h('li', {
      key: label,
      class: `upload-stage is-${state}`,
      'aria-current': state === 'act' || state === 'live' ? 'step' : null,
    },
    // The words say the same: read out, the mark would run into the name of the stage.
    h('span', { class: 'upload-stage-mark', 'aria-hidden': 'true' }, marks[state] ? icon(marks[state]) : String(index + 1)),
    h('span', { class: 'upload-stage-words' },
      h('span', { class: 'upload-stage-label' }, label),
      h('span', { class: 'sr-only' }, ': '),
      h('span', { class: 'upload-stage-word' }, word)))));
}

/**
 * What the server answered to an upload that it accepted. Every value is from its reply:
 * it answers like this only when every check in IMAGE_CHECKS has passed.
 */
function verifiedResult(ctx) {
  const { release } = ctx.state.upload;
  const { actions } = ctx;
  const fingerprint = ctx.state.firmware.value?.fingerprint ?? '';
  const sizes = release.size === null
    ? null
    : ['Size', sizeWords(release.size),
      release.headerSize === null || release.payloadSize === null
        ? null
        : factNote(`${exactBytes(release.headerSize)} of header, ${exactBytes(release.payloadSize)} of firmware, then the signature.`)];
  const deployed = deployedAlready(ctx);
  return h('div', { class: 'upload-state is-verified' },
    h('p', { class: 'verified-title' }, icon('shield'), 'Verified by the server'),
    h('p', { class: 'upload-title is-good' }, icon('check-circle'), 'Registered as ', mono(release.version)),
    h('p', { class: 'verified-text' }, deployed
      ? 'The signature is valid and the image is stored. A deployment of it has been started.'
      : 'The signature is valid and the image is stored. It can now be offered to boards.'),
    h('div', { class: 'button-row' },
      deployed
        ? h('a', { class: 'btn is-primary is-large', href: deploymentHref(deployed.id) }, 'Open its deployment', icon('arrow-right'))
        : button('is-primary is-large', () => actions.openDeploy(release.version), icon('send'), 'Deploy this release'),
      deployed ? button('', () => actions.openDeploy(release.version), icon('send'), 'Deploy it again') : null,
      button('', actions.resetUpload, 'Upload another')),
    facts([
      ['Signature', h('span', { class: 'status is-good' }, icon('check-circle'), h('span', null, 'ECDSA P-256, valid'))],
      release.keyHash
        ? ['Signing key', mono(release.keyHash, 'digest'),
          factNote(release.keyHash === fingerprint
            ? 'The fingerprint of this project’s signing key.'
            : 'The fingerprint of the key that signed it.')]
        : null,
      ['Version', mono(release.version, 'fact-strong'), factNote('Read from the signed header of the image.')],
      sizes,
      release.sha256 ? ['SHA-256', mono(release.sha256, 'digest')] : null,
      release.loadAddress === null ? null : ['Load address', mono(`0x${release.loadAddress.toString(16)}`)],
    ]));
}

/**
 * The proof next to the verdict, on the first screen, where the explanation of what the
 * server would check stood before there was a result. The first release has nothing
 * before it to be newer than.
 */
function verifiedProof(ctx) {
  const { version } = ctx.state.upload.release;
  const releases = ctx.state.firmware.value?.releases ?? [];
  const first = releases.length > 0 && releases.every((release) => release.version === version);
  return h('div', { class: 'trust verified-checks', key: 'proof' },
    h('h3', { class: 'trust-title' }, icon('shield'), 'What the server checked'),
    h('ul', { class: 'checks' }, IMAGE_CHECKS.map(({ passed, passedFirst }) => {
      const words = first && passedFirst ? passedFirst : passed;
      return h('li', { key: passed, class: 'check is-good' }, icon(CHECK_ICONS.good), h('span', null, words));
    })),
    h('p', { class: 'verified-after' }, 'The board’s bootloader checks the same signature again before it starts the image.'));
}

/**
 * What the upload panel has to say to a screen reader. The panel changes as a whole from
 * one stage to the next, so its words go through a line that is always there: text that
 * appears together with its live region is not reliably read out. A refusal has a role
 * of its own in the notice that says it.
 */
function uploadSummary(ctx) {
  const { upload } = ctx.state;
  switch (upload.stage) {
    case 'reading':
      return `Reading ${upload.name}.`;
    case 'ready': {
      const review = reviewImage(upload, ctx.state.firmware.value);
      const version = upload.header.ok ? ` Version ${upload.header.version}.` : '';
      return `${upload.name}.${version} ${review.notes.map((note) => note.text).join(' ')}`;
    }
    case 'sending':
      return 'Uploading.';
    case 'checking':
      return 'Uploaded. The server is verifying the signature.';
    case 'done':
      return stillRegistered(ctx)
        ? `Registered as ${upload.release.version}. The signature is valid and the image is stored.`
        : '';
    case 'refused':
      return refusedForGood(upload) ? 'Nothing was stored.' : '';
    default:
      return '';
  }
}

/** Which of the server's checks an image failed, in words, and what that leaves behind. */
function refusalFacts(error) {
  const check = failedCheck(error.code);
  return h('p', { class: 'notice-more upload-refusal' },
    check ? ['Check that failed: ', h('strong', null, check), '. '] : null,
    'Nothing was stored.');
}

function uploadPanel(ctx) {
  const { upload } = ctx.state;
  const { actions } = ctx;

  if (upload.stage === 'idle') return dropZone(ctx);
  if (upload.stage === 'reading') {
    return h('div', { class: 'upload-state' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      h('p', { class: 'quiet' }, 'Reading the file…'));
  }
  if (upload.stage === 'done') {
    // Revoked since: there is nothing left to offer, and the panel is ready for the next file.
    return stillRegistered(ctx) ? verifiedResult(ctx) : dropZone(ctx);
  }

  const review = reviewImage(upload, ctx.state.firmware.value);
  const busy = upload.stage === 'sending' || upload.stage === 'checking';
  const refused = upload.stage === 'refused';
  // A refusal of the file itself is final: sending the same bytes again cannot end
  // differently, so the way on is another file. A request that failed can be repeated.
  const final = refused && !canRetryUpload(upload.error);
  const ofImage = refusedForGood(upload);
  const percent = Math.round((upload.sent ?? 0) * 100);
  const { header } = upload;
  // What is certain to be refused is not going to be sent, so nothing will check its signature.
  const doomed = review.doomed && !refused;
  // Once the server has refused the file, what was expected of it has no more to say.
  // Before that the list says what is known; the server's answer says the rest.
  let checks = [...review.notes, SIGNATURE_UNCHECKED];
  if (final) checks = [];
  // On its way, the line below says what is being done about the signature.
  else if (review.blocked || refused || doomed || busy) checks = review.notes;
  const ended = ctx.state.sessionLeft <= 0;

  let next = null;
  if (upload.stage === 'sending') {
    // The figure is for the eye. The progress bar carries it for a screen reader, and
    // uploadSummary() says what is going on once.
    next = h('div', { class: 'upload-progress' },
      h('p', null, 'Uploading…', h('span', { 'aria-hidden': 'true' }, ` ${percent}%`)),
      meter(percent, 'Upload'));
  } else if (upload.stage === 'checking') {
    next = h('div', { class: 'upload-progress' },
      h('p', { class: 'upload-verifying' }, 'Uploaded. The server is verifying the signature…'),
      h('div', { class: 'meter is-busy' }, h('span', { class: 'meter-fill' })));
  } else if (final || doomed) {
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
      // With the session over, the notice above has the one thing that can be done.
      ended
        ? null
        : h('div', { class: 'button-row', key: 'send' },
          button('is-primary', actions.startUpload,
            icon('upload'), refused ? 'Try again' : 'Upload for verification')),
    ];
  }

  return h('div', { class: 'upload-state' },
    h('div', { class: 'upload-file' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      busy || final || doomed ? null : button('is-small', actions.resetUpload, 'Choose another file')),
    header.ok
      ? facts([
        ['Version', mono(header.version, 'fact-strong')],
        ['Size', sizeWords(upload.size)],
        ['SHA-256', mono(upload.digest, 'digest')],
        ['Layout',
          `${exactBytes(header.headerSize)} of header, ${exactBytes(header.payloadSize)} of firmware`],
        upload.recordedAs !== upload.name ? ['Recorded as', mono(upload.recordedAs)] : null,
      ])
      : null,
    checks.length > 0
      ? h('ul', { class: 'checks', key: 'checks' }, checks.map((note) =>
        h('li', { key: note.text, class: `check is-${note.tone}` },
          icon(CHECK_ICONS[note.tone]), h('span', null, prose(note.text)))))
      : null,
    refused
      ? failure(ofImage ? 'The server refused this image.' : 'The image was not stored.', upload.error,
        ofImage ? refusalFacts(upload.error) : null, actions.signInAgain)
      : null,
    next);
}

/** Who did something, with the account id written out: a tooltip cannot be read on a touch screen. */
function byAccount(person) {
  return factNote(['by ', nameOf(person), person?.sub ? [' · account ', mono(person.sub)] : null]);
}

function signedWords(release, fingerprint) {
  if (signedWithOldKey(release, fingerprint)) return 'Not the current signing key. This release was signed with an earlier key, which has been replaced since.';
  return release.keyHash === fingerprint ? 'Matches this project’s signing key.' : 'Fingerprint of the key that signed it.';
}

function releaseDetails(release, fingerprint) {
  const sizes = `${exactBytes(release.size)}: ${exactBytes(release.headerSize)} of header, ` +
    `${exactBytes(release.payloadSize)} of firmware, then the signature`;
  const { revoked } = release;
  return h('details', { class: 'more' },
    h('summary', null, 'Details', h('span', { class: 'sr-only' }, ` of ${release.version}`)),
    facts([
      ['File', mono(release.filename)],
      ['Size', sizes],
      ['File SHA-256', mono(release.sha256, 'digest'), factNote('What a board checks after downloading.')],
      ['Image hash', mono(release.imageHash, 'digest'),
        factNote('What the signature covers and the bootloader verifies.')],
      ['Signed with', mono(release.keyHash, 'digest'), factNote(signedWords(release, fingerprint))],
      ['Load address', mono(`0x${(release.loadAddress ?? 0).toString(16)}`)],
      ['Uploaded', exactTime(release.uploadedAt), byAccount(release.uploadedBy)],
      revoked ? ['Revoked', exactTime(revoked.at), byAccount(revoked.by)] : null,
      revoked?.enforcedAt
        ? ['Enforced', exactTime(revoked.enforcedAt),
          factNote('The image is refused and every open deployment of it was cancelled.')]
        : null,
    ]));
}

/** How much of a board's update slot an image takes. */
function slotFit(release, slot) {
  if (!slot) return null;
  const percent = (release.size / slot) * 100;
  const told = percent < 1 ? 'under 1%' : `${Math.round(percent)}%`;
  return h('div', { class: 'slot-fit' },
    h('span', {
      class: 'slot-fit-bar',
      'aria-hidden': 'true',
      vars: { '--fit': `${Math.min(100, percent).toFixed(2)}%` },
    }, h('span', { class: 'slot-fit-fill' })),
    h('span', { class: 'slot-fit-words' }, `Takes ${told} of the ${fileSize(slot)} update slot`));
}

// The most releases the timeline shows; the list under it has them all.
const TIMELINE_RELEASES = 6;

/**
 * The releases in the order they were uploaded, evenly spaced, with the time between
 * them written on the line. On a true time axis two uploads an hour apart would land
 * on top of each other next to one from last month.
 */
function releaseTimeline(firmware, devices, now, onInk) {
  const { releases } = firmware;
  const newest = releases.find((release) => release.status === 'active') ?? null;
  const shown = releases.slice(0, TIMELINE_RELEASES).reverse();
  const earlier = releases.length - shown.length;
  const revoked = releases.filter((release) => release.status !== 'active').length;
  const counted = new Map();
  const quiet = new Set();
  for (const device of devices ?? []) {
    if (!device.fw) continue;
    counted.set(device.fw.version, (counted.get(device.fw.version) ?? 0) + 1);
    if (!device.online) quiet.add(device.fw.version);
  }
  const gap = (from, to) => {
    const seconds = (to - Date.parse(from)) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? duration(seconds) : '';
  };

  return h('section', { class: `timeline-panel ${onInk ? 'panel on-ink' : 'is-on-paper'}`, key: 'timeline' },
    h('div', { class: 'timeline-head' },
      h('h2', { class: onInk ? 'eyebrow' : 'section-title timeline-title' }, 'Release timeline'),
      h('p', { class: 'timeline-count dotted' },
        h('span', null, plural(releases.length, 'release')),
        revoked > 0 ? h('span', null, `${revoked} revoked`) : null,
        earlier > 0 ? h('span', null, `the newest ${shown.length} shown`) : null)),
    h('ol', { class: 'timeline', vars: { '--stations': String(shown.length) } },
      shown.map((release, index) => {
        const next = shown[index + 1];
        const isNewest = release === newest;
        const active = release.status === 'active';
        let state = 'is-active';
        if (isNewest) state = 'is-newest';
        else if (!active) state = 'is-revoked';
        let word = 'Active';
        if (isNewest) word = 'Newest release';
        else if (!active) word = 'Revoked';
        const boards = counted.get(release.version) ?? 0;
        return h('li', { key: release.version, class: `station ${state}` },
          h('span', { class: 'station-mark' }, active ? null : icon('x')),
          h('span', { class: 'station-version mono' }, release.version),
          h('span', { class: 'station-state' }, word),
          h('span', { class: 'station-when' }, when(release.uploadedAt, now)),
          devices && boards > 0
            ? h('span', { class: 'station-boards' }, `${plural(boards, 'board')} on it${quiet.has(release.version) ? ' when last seen' : ''}`)
            : null,
          h('span', {
            class: 'station-gap',
            title: next ? 'Time until the next upload' : 'Time since this upload',
          },
          h('span', { class: 'sr-only' }, next ? 'Next upload after ' : 'That was '),
          next ? gap(release.uploadedAt, Date.parse(next.uploadedAt)) : gap(release.uploadedAt, now),
          next ? null : h('span', { class: 'sr-only' }, ' ago')));
      }),
      h('li', { key: 'now', class: 'station is-now', 'aria-hidden': 'true' },
        h('span', { class: 'station-mark' }), h('span', { class: 'station-state' }, 'Now'))));
}

function releaseRow(release, ctx) {
  const { now, me } = ctx.state;
  const { actions } = ctx;
  const active = release.status === 'active';
  const revocation = revocationState(release);

  let controls = null;
  if (me.canWrite && active) {
    // Every row has the same two buttons. Their names say which release they act on.
    controls = [
      h('button', {
        type: 'button',
        class: 'btn is-small',
        'aria-label': `Deploy ${release.version}`,
        onClick: () => actions.openDeploy(release.version),
      }, icon('send'), 'Deploy'),
      h('button', {
        type: 'button',
        class: 'btn is-small is-danger-quiet',
        'aria-label': `Revoke ${release.version}`,
        onClick: () => actions.openRevoke(release),
      }, icon('ban'), 'Revoke'),
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
      h('div', { class: 'release-story' },
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
          : null),
      h('div', { class: 'release-numbers' },
        slotFit(release, ctx.state.firmware.value.slotSize),
        h('p', { class: 'row-note dotted' },
          h('span', null, fileSize(release.size)),
          h('span', null, 'Uploaded ', when(release.uploadedAt, now), ' by ', who(release.uploadedBy))),
        h('p', { class: 'row-note digest-row' },
          'SHA-256 ', mono(`${release.sha256.slice(0, 16)}…`),
          copyButton(release.sha256, `the SHA-256 of ${release.version}`, ctx)))),
    controls ? h('div', { class: 'release-actions' }, controls) : null,
    // Across the whole row, below the buttons, so that the tables of all releases are
    // equally wide and the keyboard goes through the row from top to bottom.
    releaseDetails(release, ctx.state.firmware.value.fingerprint));
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
        ? prose('Build the firmware, then upload binaries/latest.signed.bin to register the first release.')
        : 'A release manager can upload the first signed image.',
    }));
  } else {
    releases = card({ key: 'releases', className: 'is-flush' },
      h('ul', { class: 'rows' }, firmware.releases.map((release) => releaseRow(release, ctx))));
  }
  const timeline = firmware && firmware.releases.length > 0
    ? releaseTimeline(firmware, state.devices.value?.devices ?? null, state.now, !canWrite)
    : null;
  return h('div', { class: 'page' },
    pageHead({
      title: 'Firmware',
      lede: 'Signed images that can be offered to boards. A version, once used, is never reused.',
      tools: freshness(state.firmware, ctx),
    }),
    loadProblem(state.firmware, 'the releases', ctx),
    // The one ink panel of the page holds what the reader is here to do: a release manager
    // takes a file from the desk to the boards. A viewer has the releases to read.
    canWrite
      ? h('section', { class: 'upload panel on-ink', key: 'upload' },
        h('div', { class: 'upload-main', tabindex: '-1', 'data-focus-home': '' },
          h('h2', { class: 'eyebrow' }, 'Upload, verify, deploy'),
          h('p', { class: 'sr-only', role: 'status' }, uploadSummary(ctx)),
          uploadStages(ctx),
          uploadPanel(ctx)),
        state.upload.stage === 'done' && stillRegistered(ctx) ? verifiedProof(ctx) : trustPanel(ctx))
      : null,
    timeline,
    canWrite ? null : h('section', { class: 'card upload is-readonly', key: 'upload' }, trustPanel(ctx)),
    h('h2', { class: 'section-title', key: 'title' }, 'Releases'),
    releases);
}

// Deployments.

function countList(counts, atButton, percent = null) {
  return h('ul', { class: 'counts' }, describeCounts(counts, atButton).map((entry) =>
    h('li', { key: entry.name, class: `status is-${entry.tone}` },
      icon(entry.icon), h('span', null, `${entry.count} ${entry.label}`,
        percent !== null && entry.name === 'inProgress' ? h('span', { class: 'status-value' }, ` · ${percent}%`) : null))));
}

/** The boards that wait for a person, among those of these deployments. */
function waitingForButton(devices, ids) {
  return devices.filter((device) => device.online && device.ota?.state === 'awaiting_user' && ids.has(device.ota.job)).length;
}

/** How far the download is, where one board is downloading and so one number can say it. */
function onePercent(devices, ids, updating) {
  const moving = devices.filter((device) => device.online && device.ota?.state === 'downloading' &&
    ids.has(device.ota.job) && Number.isFinite(device.ota.progress));
  return updating === 1 && moving.length === 1 ? moving[0].ota.progress : null;
}

function deploymentRow(deployment, ctx) {
  const now = ctx.state.now;
  const summary = describeDeployment(deployment);
  // Whether a waiting board needs a person, and how far one is, is in what the boards say.
  const devices = ctx.state.devices.value?.devices ?? [];
  const own = new Set([deployment.id]);
  const atButton = waitingForButton(devices, own);
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
    h('div', { class: 'row-outcome' },
      // One board is not a share of anything: a full bar would read as a finished one.
      deployment.things.length > 1
        ? segments(countParts(deployment.counts, atButton), `Boards: ${countWords(deployment.counts, atButton)}.`, { thin: true })
        : null,
      countList(deployment.counts, atButton, onePercent(devices, own, deployment.counts.inProgress))),
    h('span', { class: 'row-chevron' }, icon('arrow-right')));
}

/** Every board of every deployment, by how it went, at the top of the Deployments page. */
function deploymentsPanel(deployments, ctx) {
  const total = {};
  for (const { counts } of deployments) {
    for (const [name, count] of Object.entries(counts)) total[name] = (total[name] ?? 0) + count;
  }
  const devices = ctx.state.devices.value?.devices ?? [];
  const ids = new Set(deployments.map((deployment) => deployment.id));
  const atButton = waitingForButton(devices, ids);
  const parts = countParts(total, atButton);
  const boards = parts.reduce((sum, part) => sum + part.amount, 0);
  const underWay = deployments.filter(isUnderWay).length;
  const percent = onePercent(devices, ids, total.inProgress);
  return h('section', { class: 'panel on-ink deployments-panel', key: 'panel', 'aria-label': 'All deployments at a glance' },
    stats([
      ['Deployments', deployments.length],
      ['Under way', underWay],
    ]),
    h('div', { class: 'outcomes' },
      h('p', { class: 'eyebrow' }, 'Where each board’s update stands'),
      boards > 0
        ? [
          // One update is not a share of anything: the words below it say all there is.
          boards > 1
            ? h('div', { key: 'bar' }, segments(parts, `${plural(boards, 'board update')}: ${countWords(total, atButton)}.`))
            : null,
          h('ul', { class: 'legend', key: 'legend' }, describeCounts(total, atButton).map((entry) =>
            h('li', { key: entry.name, class: 'legend-item' },
              boards > 1 ? h('span', { class: `swatch is-${entry.tone}` }) : null,
              icon(entry.icon, 'is-small'),
              h('span', null, boards > 1 ? entry.label : `${entry.count} ${entry.label}`,
                percent !== null && entry.name === 'inProgress' ? ` · ${percent}%` : null)))),
        ]
        : h('p', { class: 'quiet', key: 'none' }, 'AWS IoT has not listed any board for these deployments yet.')));
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
    body = [
      deploymentsPanel(deployments, ctx),
      card({ key: 'list', className: 'is-flush' },
        h('ul', { class: 'rows' }, deployments.map((deployment) => deploymentRow(deployment, ctx)))),
    ];
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
      lede: 'A deployment sends one release to a set of boards. ' +
        `A board on firmware ${FIRST_WITH_NO_BUTTON} or newer starts as soon as it sees it, and older firmware ` +
        'waits for someone to press Button 1 on the board. ' +
        'A job made directly in AWS IoT is not listed here; its board’s page shows it.',
      tools: [freshness(state.deployments, ctx), start],
    }),
    loadProblem(state.deployments, 'the deployments', ctx),
    body);
}

function executionPresence(execution, known, unread) {
  // Cancelled after it started: a board in the middle of a restart still counts as online
  // for a while, and only the board list tells. Until that has been read, nothing is said.
  if (unread && execution.status === 'CANCELED' && execution.startedAt) return badge('idle', 'clock', 'Not known yet');
  // While the update runs its phase says so. Once it was cancelled the phase no longer
  // does, and what the board itself last said still counts.
  const restarting = execution.phase === 'rebooting' || (known && isRestarting(known));
  if (execution.online && restarting) return badge('idle', 'restart', 'Restarting');
  if (execution.online) return badge('good', 'online', 'Online');
  if (known && !known.lastSeen) return badge('idle', 'minus-circle', 'Never connected');
  return badge('idle', 'offline', 'Offline');
}

// With several boards, only one that is moving, waiting for a person or stopped keeps the
// whole panel; the others take a line, in the same order, so that nothing jumps.
const MOST_FULL_PANELS = 3;
const FULL_TONES = new Set(['act', 'live', 'bad']);

/**
 * What a board's history says about a deployment that it is part of: see describeExecution.
 * A copy read before the board got to what it runs now says nothing about how it got
 * there, so it does not count as an answer: not yet read, as far as this goes.
 */
function historyOf(execution, ctx) {
  const detail = ctx.state.deviceDetails.get(execution.thing)?.value ?? null;
  if (detail === null || detail.device.fw?.version !== execution.reported) return { history: null, historyCut: false };
  return { history: detail.executions, historyCut: detail.olderExecutions > 0 };
}

/** The boards of a deployment whose own list of updates is needed to say how it ended, and cannot be read. */
function unreadHistories(deployment, ctx) {
  return deployment.executions
    .filter((execution) => execution.status === 'CANCELED' && execution.reported === deployment.version &&
      historyOf(execution, ctx).history === null)
    .map((execution) => ctx.state.deviceDetails.get(execution.thing))
    .filter((resource) => resource?.error);
}

/** One board's part in a deployment: what it is doing, in words and as steps. */
function executionCard(execution, deployment, ctx, boards = 1) {
  const { now } = ctx.state;
  const known = (ctx.state.devices.value?.devices ?? []).find((device) => device.thing === execution.thing);
  const unread = ctx.state.devices.value === null;
  const description = describeExecution(execution, {
    board: known ?? null, deployment: deployment.id, version: deployment.version, ...historyOf(execution, ctx), unread,
  });
  const target = deployment.version ?? versionOfDeployment(deployment.id);
  const finished = !isUnfinished(execution.status);
  const compact = boards > 1 && (boards > MOST_FULL_PANELS || !FULL_TONES.has(description.tone));
  // What to do about an update that ended short: to offer it again, the release has to
  // be there still and the reader has to be able to deploy.
  const offerable = !revokedVersions(ctx).has(deployment.version);
  // Every one of these asks for something only a release manager can do.
  const next = description.next && ctx.state.me.canWrite && (offerable || !description.retry) ? description.next : null;
  const moments = [
    execution.queuedAt ? ['Offered ', whenAt(execution.queuedAt, now)] : null,
    execution.startedAt ? ['Started ', whenAt(execution.startedAt, now)] : null,
    // AWS's record of an execution does not move with the download, so while the board
    // is at work this would claim that the board had gone quiet.
    finished && description.tone !== 'live' && execution.lastUpdatedAt
      ? ['Ended ', whenAt(execution.lastUpdatedAt, now)]
      : null,
    execution.status === 'IN_PROGRESS' && execution.secondsLeft !== null
      ? `Times out in ${duration(execution.secondsLeft)}`
      : null,
    // The board's own word on what it runs, when the deployment's record names no version.
    finished && !execution.ranAtEnd && !execution.reported && known?.fw
      ? [known.online ? 'Board now reports ' : 'Board last reported ', mono(known.fw.version)]
      : null,
    !execution.online && known?.lastSeen ? ['Board last seen ', when(known.lastSeen, now)] : null,
  ].filter(Boolean);
  const flash = compact ? null : slotsOfExecution(execution, known, target, description, deployment.id);

  return h('article', {
    key: execution.thing,
    class: `card execution is-${description.tone}${compact ? ' is-compact' : ''}`,
  },
    h('header', { class: 'execution-head' },
      h('h2', { class: 'execution-name' },
        linkTo(deviceHref(execution.thing), { class: 'mono' }, execution.thing)),
      executionPresence(execution, known, unread)),
    h('div', { class: 'execution-state' },
      h('div', { class: 'execution-words' },
        h('p', { class: `execution-title status is-${description.tone}` },
          icon(description.icon),
          // The figure is for the eye, and outside the live region. The progress bar carries
          // it for a screen reader, which would otherwise read out every change of this line.
          h('span', null,
            h('span', { role: 'status' }, description.said ?? description.title),
            description.progress !== null
              ? h('span', { class: 'said-big', 'aria-hidden': 'true' }, ` ${description.progress}%`)
              : null)),
        h('p', { class: 'execution-text' }, prose(description.text)),
        next ? h('p', { class: 'execution-next' }, next) : null,
        description.installedBy
          ? h('p', { class: 'execution-next' },
            linkTo(deploymentHref(description.installedBy), null, 'Open the deployment that installed it'))
          : null,
        description.code
          ? h('p', { class: 'execution-code' }, 'The board gave the reason ', mono(description.code))
          : null,
        execution.detail
          ? h('p', { class: 'execution-code' }, 'Board’s note: ', mono(execution.detail))
          : null,
        description.progress !== null
          ? meter(description.progress, `Download on ${execution.thing}`)
          : null),
      description.progress !== null
        ? h('p', { class: 'execution-figure', 'aria-hidden': 'true' },
          String(description.progress), h('span', { class: 'execution-percent' }, '%'))
        : null,
      description.tone === 'act' ? buttonKeys() : null),
    h('div', { class: 'pipeline', key: 'pipeline' },
      returnPath(execution, description),
      stepList(description, { compact, viewer: !ctx.state.me.canWrite })),
    h('div', { class: 'execution-lower', key: 'lower' },
      flash,
      moments.length > 0
        ? h('section', { class: 'moments', key: 'moments', 'aria-label': 'What happened when' },
          compact ? null : h('h3', { class: 'eyebrow' }, 'What happened when'),
          h('p', { class: 'execution-foot' },
            moments.map((moment, index) => h('span', { key: String(index), class: 'moment' }, moment))))
        : null));
}

/** True if the log shows this deployment cancelled before its release was revoked. */
function cancelledFirst(entry, release) {
  return Boolean(entry) && Date.parse(entry.at) < Date.parse(release.revoked.at);
}

/**
 * Who cancelled a deployment and why, as far as the log and the list of releases tell.
 * The record of the job itself says neither. That its release was revoked is said on any
 * deployment of it, over or not.
 */
function cancellation(deployment, ctx) {
  const { now } = ctx.state;
  const cancelled = deployment.status === 'CANCELED';
  // The log is newest first, and what counts is the cancellation that took the deployment off the list.
  const entry = cancelled
    ? (ctx.state.audit.value?.entries ?? []).findLast((candidate) =>
      candidate.action === 'deployment.cancel' && candidate.outcome === 'ok' && candidate.target === deployment.id)
    : null;
  const release = (ctx.state.firmware.value?.releases ?? []).find((item) => item.version === deployment.version);
  return {
    by: entry
      ? h('span', { key: 'cancelled' }, 'Cancelled ', whenAt(entry.at, now), ' by ', who(entry.actor))
      : null,
    because: release?.revoked
      ? h('div', { key: 'revoked', class: 'page-notice' },
        notice('idle', 'ban', [
          mono(release.version), ' was revoked ', when(release.revoked.at, now), ' by ', who(release.revoked.by),
          release.revoked.reason ? [': ', sentence(release.revoked.reason)] : '.',
          // Cancelled by hand before that, the revocation is not why it stopped.
          !cancelled || cancelledFirst(entry, release) ? null : ' Revoking cancels every open deployment of a release.',
        ], { action: h('a', { class: 'btn is-small', href: '#/firmware' }, 'Firmware', icon('arrow-right')) }))
      : null,
  };
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
  // Cancelled without force, and boards are still at it: the badge alone would stand
  // next to a board that goes on downloading, with no word on why.
  const withdrawn = unfinished && deployment.status === 'CANCELED';
  const atWork = withdrawn && deployment.executions.some((execution) => execution.status === 'IN_PROGRESS');
  const { by, because } = deployment ? cancellation(deployment, ctx) : { by: null, because: null };
  // A deployment that ended short can be offered again, if its release is still there and a
  // board would not refuse it, which describeExecution() has weighed.
  const boards = state.devices.value?.devices ?? [];
  const shortOfDone = deployment && !unfinished && !isUnderWay(deployment) && deployment.executions.some(
    (execution) => describeExecution(execution, {
      board: boards.find((device) => device.thing === execution.thing) ?? null,
      deployment: id,
      version: deployment.version,
      unread: state.devices.value === null,
    }).retry);
  const offerAgain = shortOfDone && state.me.canWrite && state.firmware.value !== null &&
    !revokedVersions(ctx).has(deployment.version);

  if (missing(resource)) {
    return h('div', { class: 'page' },
      pageHead({
        back: { href: '#/deployments', label: 'Deployments' },
        eyebrow: 'Deployment',
        title: 'Not found',
      }),
      card({ key: 'none' }, empty({
        iconName: 'send',
        title: 'There is no deployment with this address.',
        text: 'Check the address, or find it in the list of deployments.',
        action: { href: '#/deployments', label: 'All deployments' },
      })));
  }

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
        h('span', { key: 'started' },
          startedBy(deployment, state.now, whenAt),
          deployment.completedAt ? [', finished ', whenAt(deployment.completedAt, state.now)] : null),
        by,
        h('span', { key: 'id', class: 'digest-row' },
          mono(deployment.id), copyButton(deployment.id, 'the deployment ID', ctx)),
      ]
      : null,
    tools: [
      freshness(resource, ctx),
      // Keyed: when a deployment ends, "Offer again" is not the cancel button under another
      // name, and the keyboard goes to the page's title rather than on to it by accident.
      state.me.canWrite && unfinished
        ? h('button', {
          key: 'cancel',
          type: 'button',
          class: 'btn is-danger-quiet',
          onClick: () => ctx.actions.openCancel(deployment),
        }, icon('stop'), withdrawn ? 'Stop boards that have started' : 'Cancel deployment')
        : null,
      offerAgain
        ? h('button', {
          key: 'offer',
          type: 'button',
          class: 'btn',
          onClick: () => ctx.actions.openDeploy(deployment.version),
        }, icon('send'), 'Offer again')
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
    // What the page cannot say until these have been read, and does not say.
    state.devices.value === null ? loadProblem(state.devices, 'the list of boards', ctx) : null,
    unreadHistories(deployment, ctx).slice(0, 1).map((known) => loadProblem(known, 'the board’s list of updates', ctx)),
    withdrawn
      ? h('div', { key: 'withdrawn', class: 'page-notice' },
        notice('idle', 'stop', atWork
          ? 'This deployment was cancelled. A board that had already started carries on unless it is stopped.'
          : 'This deployment was cancelled. AWS takes a few seconds to withdraw the offer from every board.'))
      : null,
    because,
    deployment.executions.length === 0
      ? card({ key: 'none' },
        h('p', { class: 'quiet' }, 'AWS IoT has not listed any board for this deployment yet.'))
      : [
        deployment.executions.length > 1
          ? h('div', { class: 'deployment-summary', key: 'summary' },
            segments(countParts(deployment.counts), `Boards: ${countWords(deployment.counts)}.`, { thin: true }),
            countList(deployment.counts))
          : null,
        h('div', { class: 'executions', key: 'boards' },
          deployment.executions.map((execution) =>
            executionCard(execution, deployment, ctx, deployment.executions.length))),
      ]);
}

// Activity.

/** What the entries on this page are about. It only counts what has been loaded, and says so. */
function activityPanel(audit) {
  const { entries } = audit;
  const count = (test) => entries.filter(test).length;
  const action = (name) => (entry) => entry.action === name;
  const refused = count((entry) => entry.outcome !== 'ok');
  const said = [
    [count(action('firmware.upload')), 'upload', 'uploads'],
    [count(action('deployment.create')), 'deployment', 'deployments'],
    [count(action('deployment.cancel')), 'cancellation', 'cancellations'],
    [count(action('firmware.revoke')), 'revocation', 'revocations'],
  ].filter(([amount]) => amount > 0);
  return h('p', { class: 'log-summary dotted', key: 'summary' },
    h('span', { key: 'scope', class: 'log-scope' },
      audit.next
        ? `The latest ${plural(entries.length, 'entry', 'entries')}`
        : `${entries.length === 1 ? 'The only entry' : `All ${entries.length} entries`}`),
    said.map(([amount, one, many]) => h('span', { key: one }, plural(amount, one, many))),
    refused > 0
      ? h('span', { key: 'refused', class: 'status is-warn' }, icon('alert', 'is-small'), `${refused} refused or failed`)
      : null);
}

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
      text: 'Uploads, deployments, cancellations and revocations made through this console’s API will appear here, ' +
        'including attempts that were refused.',
    }));
  } else {
    body = [
      activityPanel(audit),
      scriptedKey(audit.entries, ''),
      days.map((day) => h('section', { key: day.label, class: 'log-day' },
        h('h2', { class: 'log-day-title' }, day.label),
        h('ul', { class: 'log' }, day.entries.map((entry) => activityLine(entry, ctx, false))))),
      h('div', { class: 'log-more', key: 'more' },
        audit.next
          ? h('button', {
            type: 'button',
            class: 'btn',
            disabled: state.audit.loadingMore,
            onClick: ctx.actions.loadMoreActivity,
          }, state.audit.loadingMore ? 'Loading…' : 'Load more')
          : h('p', { class: 'quiet' }, 'That is every entry in this log.'),
        state.audit.moreError ? failure('Could not load more.', state.audit.moreError) : null),
    ];
  }
  return h('div', { class: 'page' },
    pageHead({
      title: 'Activity',
      lede: 'Every upload, deployment, cancellation and revocation made through this console’s API, with who asked ' +
        'for it and whether it went through. A job made directly in AWS IoT does not pass through that API, so it is ' +
        'not in this log, though its board’s page lists it. A deployment that is over shows how it ended. ' +
        'This console has no way to change an entry.',
      tools: freshness(state.audit, ctx),
    }),
    loadProblem(state.audit, 'the activity log', ctx),
    body);
}

// Dialogs. Each is a form inside a <dialog>. It acts when one of its buttons is used,
// never because Enter was pressed in a field, and every button says what it does.

function dialogFrame({ title, body, error, foot, onSubmit, onClose, busy }) {
  return h('form', {
    class: 'dialog-form',
    method: 'dialog',
    // Where the keyboard goes if the control that had it is gone.
    tabindex: '-1',
    'data-focus-home': '',
    onKeydown: ignoreEnter,
    onSubmit(event) {
      event.preventDefault();
      if (onSubmit && !busy) onSubmit();
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
  // What the server said to a request that failed stands outside the part that
  // scrolls, above the button that was used: in a small window it would otherwise
  // lie below what can be seen, and the dialog would seem to have done nothing.
  error ? h('div', { class: 'dialog-error', key: 'error' }, error) : null,
  h('footer', { class: 'dialog-foot' }, foot));
}

/**
 * A button in the foot of a dialog. `submit` makes it the one the form acts on.
 * `sending` holds it back while its request is on its way, in a way that leaves it the
 * keyboard's focus: a button that is disabled loses it, and a failure would then be
 * reported to a keyboard that is nowhere.
 */
function dialogButton(options, ...label) {
  const {
    key, className = '', submit = false, disabled = false, sending = false, autofocus = false,
    describedBy = null, onClick,
  } = options;
  return h('button', {
    key,
    type: submit ? 'submit' : 'button',
    class: `btn ${className}`.trim(),
    disabled,
    autofocus,
    'aria-disabled': sending ? 'true' : null,
    'aria-describedby': describedBy,
    onClick,
  }, label);
}

const SPACER = () => h('span', { class: 'dialog-spacer', key: 'spacer' });

function consequences(items) {
  return h('ul', { class: 'consequences' },
    items.filter(Boolean).map((item, index) => h('li', { key: String(index) }, item)));
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

function willRefuse() {
  return h('span', { class: 'choice-warning' }, icon('alert', 'is-small'),
    h('span', null, 'Reports that it already runs this version or a newer one, so it will refuse the offer.'));
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
        '. Finish or cancel ', linkTo(deploymentHref(busy.deployment), null, 'that deployment'), ' first.'));
  } else if (alreadyRuns(device, model.version)) {
    remark = willRefuse();
  } else if (!device.online && !device.lastSeen) {
    remark = h('span', { class: 'choice-hint' },
      `It will see the offer when it first connects. ${NEVER_REPORTED_HELP}`);
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
    device.fw ? [device.online ? 'Runs ' : 'Last reported ', mono(device.fw.version)] : 'Has not reported a version',
    device.online || !device.lastSeen ? null : [' · last seen ', when(device.lastSeen, now)]),
  remark);
}

function wizardReview(model, release, chosen, now) {
  const offline = chosen.filter((device) => !device.online && device.lastSeen).length;
  const never = chosen.filter((device) => !device.online && !device.lastSeen).length;
  const asking = chosen.filter(asksForButton).length;
  return [
    facts([
      ['Release', mono(model.version, 'fact-strong'),
        release ? factNote(`${fileSize(release.size)} · SHA-256 ${release.sha256.slice(0, 12)}…`) : null],
      ['Boards', h('ul', { class: 'plain-list' }, chosen.map((device) =>
        h('li', { key: device.thing }, mono(device.thing), presence(device, now),
          alreadyRuns(device, model.version) ? willRefuse() : null)))],
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
        ['Each board gets ', mono(model.version),
          `. Firmware ${FIRST_WITH_NO_BUTTON} or newer installs it as soon as the board sees it, with nobody at the board.`],
        asking > 0
          ? `${plural(asking, 'board runs', 'boards run')} older firmware, which installs nothing until ` +
            'someone presses Button 1 on the board; Button 2 declines.'
          : null,
        offline > 0
          ? `${plural(offline, 'board is', 'boards are')} offline and will see the update after ` +
            'reconnecting. It stays open until it is cancelled.'
          : 'It stays open until a board acts on it or the deployment is cancelled.',
        never > 0
          ? `${plural(never, 'board has', 'boards have')} never connected and will see the update ` +
            `when first connected. ${NEVER_REPORTED_HELP}`
          : null,
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
  // "All" leaves out what would only refuse: that takes a tick of its own.
  const selectable = free.filter((device) => !alreadyRuns(device, model.version));
  const ready = !model.loading && !model.loadError;
  // The release this dialog was opened for has been revoked in the meantime. It says so
  // and leaves the choice to the reader: another release is not what was asked for.
  const gone = ready && model.gone
    ? notice('warn', 'alert', [
      h('strong', null, mono(model.gone), ' has been revoked'), ', so it cannot be deployed any more.',
      releases.length > 0 ? ' Choose another release if you want to deploy one.' : null,
    ])
    : null;

  let body;
  if (model.loading) {
    body = loading('releases and boards');
  } else if (model.loadError) {
    body = notice('bad', 'alert', [
      h('strong', null, 'Could not load what a deployment needs. '),
      sentence(model.loadError.message),
    ], { more: problemRef(model.loadError), action: button('is-small', model.reload, 'Try again') });
  } else if (model.step === 0 && releases.length === 0) {
    body = [gone, empty({
      iconName: 'package',
      title: 'There is no release to deploy.',
      text: 'Upload a signed image on the Firmware page first. Revoked releases cannot be deployed.',
      // The dialog closes by itself when the page changes, but not if this is the Firmware page.
      action: { href: '#/firmware', label: 'Go to Firmware', onClick: model.close },
    })];
  } else if (model.step === 0) {
    body = [gone, h('fieldset', { class: 'choices', key: 'releases' },
      h('legend', null, 'Which release?'),
      releases.map((candidate) => wizardRelease(candidate, model, now)))];
  } else if (model.step === 1 && devices.length === 0) {
    body = empty(NO_BOARDS);
  } else if (model.step === 1) {
    body = h('fieldset', { class: 'choices' },
      h('legend', null, 'Which boards get ', mono(model.version), '?'),
      devices.map((device) => wizardBoard(device, model, now)),
      selectable.length > 1
        ? button('is-small is-quiet', model.toggleAll,
          selectable.every((device) => model.things.has(device.thing))
            ? 'Clear the selection'
            : `Select all ${selectable.length} available boards`)
        : null);
  } else {
    body = wizardReview(model, release, chosen, now);
  }

  const refusedBoards = model.error ? busyBoards(model.error) : [];
  const last = model.step === WIZARD_STEPS.length - 1;
  const canGoOn = model.step === 0 ? release !== null : chosen.length > 0;
  // Why "Next" cannot be used yet, said next to it.
  let hint = null;
  if (ready && model.step === 0 && releases.length > 0 && !release) {
    hint = 'Choose a release.';
  } else if (ready && model.step === 1 && devices.length > 0 && chosen.length === 0) {
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
      label,
      index < model.step ? h('span', { class: 'sr-only' }, ' (done)') : null))),
      // Each step takes the focus when it appears, so the keyboard starts at its top.
      // Its name is what a screen reader says on arriving there.
      h('div', {
        class: 'wizard-body',
        key: `step-${model.step}`,
        role: 'group',
        'aria-label': `Step ${model.step + 1} of ${WIZARD_STEPS.length}: ${WIZARD_STEPS[model.step]}`,
        tabindex: '-1',
        autofocus: true,
        ref(el) {
          el.focus({ preventScroll: true });
          el.parentElement.scrollTop = 0;
        },
      }, body),
    ],
    error: model.error
      ? failure('The deployment was not started.', model.error,
        refusedBoards.length > 0 ? heldBy(refusedBoards) : null, model.signIn)
      : null,
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
          disabled: chosen.length === 0,
          sending: model.sending,
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

function cancelLabel({ sending, withdrawn, force }) {
  if (withdrawn) return sending ? 'Stopping…' : 'Stop boards';
  if (sending) return 'Cancelling…';
  return force ? 'Cancel and stop boards' : 'Cancel the deployment';
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

  const version = mono(deployment.version ?? 'this release');
  return dialogFrame({
    title: withdrawn
      ? ['Stop the boards that are installing ', version, '?']
      : ['Cancel the deployment of ', version, '?'],
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
    ],
    // With nothing left to cancel, an earlier refusal to do so has nothing more to say.
    error: model.error && !over
      ? failure(withdrawn ? 'The boards were not stopped.' : 'Not cancelled.', model.error, null, model.signIn)
      : null,
    foot: [
      dialogButton({ key: 'keep', autofocus: true, disabled: model.sending, onClick: model.close },
        over || withdrawn ? 'Close' : 'Keep the deployment'),
      SPACER(),
      dialogButton({
        key: 'go', className: 'is-danger', submit: true, disabled: over, sending: model.sending,
      }, cancelLabel({ sending: model.sending, withdrawn, force })),
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
    ],
    error: model.error
      ? failure(open ? 'Not finished.' : 'Not applied.', model.error, null, model.signIn)
      : null,
    foot: [
      dialogButton({ key: 'keep', disabled: model.sending, onClick: model.close }, 'Close'),
      SPACER(),
      dialogButton({
        key: 'go', className: 'is-primary', submit: true, autofocus: true, sending: model.sending,
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
    ],
    error: model.error ? failure('Not revoked.', model.error, null, model.signIn) : null,
    foot: [
      dialogButton({
        key: 'keep', autofocus: !model.focusReason, disabled: model.sending, onClick: model.close,
      }, 'Keep the release'),
      SPACER(),
      // The field can lie below what can be seen, and the button stands in view.
      reason ? null : h('span', { class: 'dialog-hint', id: 'dialog-hint', key: 'hint' }, 'Give a reason first.'),
      dialogButton({
        key: 'go',
        className: 'is-danger',
        submit: true,
        disabled: !reason,
        sending: model.sending,
        describedBy: reason ? null : 'dialog-hint',
      }, icon('ban'), model.sending ? 'Revoking…' : ['Revoke ', release.version]),
    ],
  });
}
