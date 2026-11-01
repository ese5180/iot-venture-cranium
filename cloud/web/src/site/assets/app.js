/**
 * The console's entry point: signing in, following the address bar, loading and
 * refreshing what each page shows, and the dialogs that change something.
 *
 * State lives in one object. Whenever it changes the page is drawn again from it;
 * views.js makes that cheap. Requests are refreshed on a schedule that follows what
 * the boards are doing and stops while the tab is in the background.
 */

import {
  ApiError, SESSION_CHANNEL, SIGNED_OUT_SIGNAL, afterUnauthorized, alreadyRuns, boardChanges, cancelNotice, createApi,
  createAuth, createClock, describeExecution, deviceActivity, executionActivity, isUnderWay, isUnfinished, onlyChoice, parseRoute,
  pollInterval, readConfig, readImageHeader, recordedFilename, refreshPlan, revocationInPlace, revocationNotice,
  routeHash, sha256Hex, shouldRenew, singleLine, staleAfter, stillFinishing, stillRunning, stillSettling, summaryActivity,
  toBase64, uploadInHand, versionOfDeployment,
} from './core.js';
import {
  accountView, activityView, cancelDialog, deployDialog, deploymentView, deploymentsView, deviceView,
  devicesView, firmwareView, gateView, navView, overviewView, render, revokeDialog, scriptPending, toastView,
} from './views.js';

// Board lists, and the lists that another person can change at any time, are also
// refreshed when nothing is being installed, so that they do not go stale. Deployments
// are not: they follow pollInterval() alone.
const IDLE_REFRESH_MS = 30000;
const REDRAW_MS = 15000;
// Pressing twice on what opens a dialog is one wish. The second press lands on the backdrop.
const DOUBLE_CLICK_MS = 350;
// Time to read a message, by its length; never less than the time a short one stays.
const READING_MS_PER_CHARACTER = 80;
const SESSION_CHECK_MS = 5000;
// A refusal this soon after signing in would repeat for ever if sign-in simply restarted.
const FRESH_SIGN_IN_S = 30;
const LARGEST_FILE_READ = 8 * 1024 * 1024;
const ACTIVITY_PAGE = 50;
const RECENT_ENTRIES = 6;
const REQUESTS_AT_ONCE = 4;
const DEPLOYMENTS_ON_OVERVIEW = 4;

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const account = document.getElementById('account');
const toasts = document.getElementById('toasts');
const announcer = document.getElementById('announcer');

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

const state = {
  gate: null,
  me: null,
  route: { view: 'overview' },
  now: Date.now(),
  interval: 0,
  sessionLeft: 0,
  devices: resource(),
  firmware: resource(),
  deployments: resource(),
  recent: resource(),
  audit: { ...resource(), loadingMore: false, moreError: null },
  commits: resource(),
  scriptFailed: false,
  deviceDetails: new Map(),
  deploymentDetails: new Map(),
  upload: { stage: 'idle', over: false },
};

const clock = createClock();
let auth = null;
let api = null;
let dialog = null;

// Drawing.

let drawQueued = false;

/**
 * Draw, and keep the keyboard's place if the control that had the focus goes away with
 * what changed. It goes to the part of the page the control belonged to, or else to the
 * page's title, instead of falling out of the page.
 */
function keepingFocus(drawing) {
  const before = document.activeElement;
  const home = before?.closest?.('[data-focus-home]') ?? null;
  drawing();
  if (!before || before === document.body || before.isConnected) return;
  const now = document.activeElement;
  if (now && now !== before && now !== document.body) return;
  (home?.isConnected ? home : document.getElementById('page-title'))?.focus({ preventScroll: true });
}

// What the boards last said, by board, to tell a screen reader when that changes. The
// page of a deployment has live regions of its own, one per board.
let heard = new Map();

function announceBoards() {
  const { view, thing } = state.route;
  const detail = view === 'device' ? state.deviceDetails.get(thing)?.value : null;
  const devices = detail ? [detail.device] : state.devices.value?.devices ?? [];
  const { seen, said } = boardChanges(heard, devices);
  heard = new Map([...heard, ...seen]);
  if (said.length > 0 && view !== 'deployment' && announcer) announcer.textContent = said.join(' ');
}

function paint() {
  drawQueued = false;
  state.now = clock.now();
  if (state.gate) {
    nav.hidden = true;
    account.hidden = true;
    const node = gateView(state.gate);
    node.key = 'gate';
    render(main, node);
    return;
  }
  state.sessionLeft = auth.secondsLeft();
  const ctx = { state, actions };
  nav.hidden = false;
  account.hidden = false;
  render(nav, navView(ctx));
  render(account, accountView(ctx));
  let node;
  try {
    node = pages[state.route.view].view(ctx);
  } catch (error) {
    // A fault in a view must not leave a blank or half-drawn page behind.
    console.error(error);
    node = gateView({
      iconName: 'alert',
      title: 'This page could not be shown',
      text: 'The console ran into a problem of its own. Reload the page; if it happens again, ' +
        'report which page it was.',
      action: { label: 'Reload', run: () => location.reload() },
    });
  }
  node.key = routeHash(state.route);
  keepingFocus(() => render(main, node));
  pages[state.route.view].painted?.();
  announceBoards();
  if (dialogOpen()) dialog.redraw();
}

function draw() {
  if (drawQueued) return;
  drawQueued = true;
  queueMicrotask(paint);
}

function showGate(gate) {
  state.gate = gate;
  clearTimeout(timer);
  if (dialog) dialog.close(true);
  document.title = 'Cranium · Firmware console';
  paint();
}

// The toasts on the page, by what they say: the same message twice is one message, for longer.
const toastsShown = new Map();

function notify(message, tone = 'good') {
  const name = `${tone} ${message}`;
  if (toastsShown.has(name)) {
    toastsShown.get(name)();
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast is-${tone}`;
  let expiry = 0;
  // Where the keyboard came from, if it has come here: it goes back when the toast is gone.
  let cameFrom = null;
  const dismiss = () => {
    clearTimeout(expiry);
    const held = toast.contains(document.activeElement);
    toastsShown.delete(name);
    toast.remove();
    if (held) (cameFrom?.isConnected ? cameFrom : document.getElementById('page-title'))?.focus({ preventScroll: true });
  };
  const stay = Math.max(tone === 'good' ? 5000 : 12000, message.length * READING_MS_PER_CHARACTER);
  const countDown = () => {
    clearTimeout(expiry);
    expiry = setTimeout(dismiss, stay);
  };
  const hold = () => clearTimeout(expiry);
  render(toast, toastView(message, dismiss));
  // Not while it is being read, or while its button has the focus.
  toast.addEventListener('mouseenter', hold);
  toast.addEventListener('focusin', (event) => {
    hold();
    if (!toast.contains(event.relatedTarget)) cameFrom = event.relatedTarget;
  });
  toast.addEventListener('mouseleave', countDown);
  toast.addEventListener('focusout', countDown);
  toasts.append(toast);
  toastsShown.set(name, countDown);
  countDown();
}

/** Anything thrown that is not the API's doing is a fault in the console itself. */
function asProblem(error) {
  if (error instanceof ApiError) return error;
  console.error(error);
  return new ApiError(0, 'console', 'The console ran into a problem of its own. Reload the page.');
}

// Loading.

async function load(target, fetcher) {
  target.loading = true;
  draw();
  try {
    target.value = await fetcher();
    target.error = null;
    target.loadedAt = clock.now();
  } catch (error) {
    target.error = asProblem(error);
  } finally {
    target.loading = false;
    draw();
  }
}

function entry(map, key) {
  let item = map.get(key);
  if (!item) {
    item = resource();
    map.set(key, item);
  }
  return item;
}

function keep(map, key, value) {
  const item = entry(map, key);
  item.value = value;
  item.error = null;
  item.loadedAt = clock.now();
}

/** Run a task for every item, a few at a time. */
async function each(items, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(REQUESTS_AT_ONCE, queue.length) }, async () => {
    while (queue.length > 0) await task(queue.shift());
  });
  await Promise.all(workers);
}

function due(target, full) {
  return full || target.loadedAt === 0 || clock.now() - target.loadedAt >= IDLE_REFRESH_MS - 2000;
}

/** The deployments whose boards the overview follows one by one: those with a board still at it. */
function activeDeployments() {
  const devices = state.devices.value?.devices ?? [];
  return (state.deployments.value ?? [])
    .filter((deployment) => isUnderWay(deployment) || stillFinishing(deployment, devices, clock.now()))
    .slice(0, DEPLOYMENTS_ON_OVERVIEW);
}

function phasesOf(deployment) {
  if (!deployment) return '';
  return deployment.executions.map((execution) => `${execution.thing}:${execution.phase}`).join(' ');
}

/** The boards and the open deployments as pollInterval takes them. */
function fleetActivity() {
  const devices = state.devices.value?.devices ?? [];
  const statuses = devices.map(deviceActivity);
  for (const deployment of activeDeployments()) {
    const detail = state.deploymentDetails.get(deployment.id)?.value;
    if (detail) statuses.push(...detail.executions.map(executionActivity));
    else statuses.push(summaryActivity(deployment, devices));
    // Cancelled, with a board that is still restarting: AWS has nothing more to say, and it is not over.
    if (!isUnderWay(deployment)) statuses.push('IN_PROGRESS');
  }
  return statuses;
}

/** Read the record of each open deployment: the list only says how many boards do what. */
function readActiveDeployments() {
  return each(activeDeployments(), (deployment) =>
    load(entry(state.deploymentDetails, deployment.id), () => api.deployment(deployment.id)));
}

/** True while a cancelled deployment can still change what one of its boards runs. */
function settling(deployment) {
  const devices = state.devices.value?.devices ?? [];
  return deployment.executions.some((execution) => stillSettling(execution,
    devices.find((device) => device.thing === execution.thing), deployment.id, clock.now()));
}

/** True while the page of a deployment that is over invites somebody to offer its release again. */
function canBeOfferedAgain(detail) {
  const devices = state.devices.value?.devices ?? [];
  const release = state.firmware.value?.releases.find((item) => item.version === detail.version);
  if (release && release.status !== 'active') return false;
  return detail.executions.some((execution) => describeExecution(execution, {
    board: devices.find((device) => device.thing === execution.thing) ?? null,
    deployment: detail.id,
    version: detail.version,
    history: null,
    unread: state.devices.value === null,
  }).retry);
}

// One entry per page: how it is drawn, what it loads, and how soon to load it again
// (0 for never). `full` is false for a scheduled refresh, which skips what cannot
// have changed much. `holdStill` says that a scheduled refresh would be in the way.
const pages = {
  overview: {
    title: 'Overview',
    view: overviewView,
    resources: () => [state.devices, state.deployments, state.firmware, state.recent],
    async refresh(full) {
      await Promise.all([
        load(state.devices, api.devices),
        load(state.deployments, api.deployments),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
        due(state.recent, full) ? load(state.recent, () => api.audit({ limit: RECENT_ENTRIES })) : null,
      ]);
      // The list says how many boards are in each state, not which board is doing
      // what. That comes from each unfinished deployment's own record.
      await readActiveDeployments();
    },
    interval: () => pollInterval(fleetActivity()) || IDLE_REFRESH_MS,
  },
  devices: {
    title: 'Devices',
    view: devicesView,
    resources: () => [state.devices],
    async refresh(full) {
      await Promise.all([
        load(state.devices, api.devices),
        load(state.deployments, api.deployments),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
      ]);
      // A board that is offline cannot report an offer. Its deployment's record says it has one.
      await readActiveDeployments();
    },
    interval: () => pollInterval(fleetActivity()) || IDLE_REFRESH_MS,
  },
  device: {
    title: (route) => `${route.thing.slice(0, 12)}…`,
    view: deviceView,
    resources: () => [entry(state.deviceDetails, state.route.thing)],
    async refresh(full) {
      const { thing } = state.route;
      await Promise.all([
        load(entry(state.deviceDetails, thing), () => api.device(thing)),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
      ]);
    },
    interval() {
      const detail = state.deviceDetails.get(state.route.thing)?.value;
      return detail ? pollInterval([deviceActivity(detail.device)]) || IDLE_REFRESH_MS : 0;
    },
  },
  firmware: {
    title: 'Firmware',
    view: firmwareView,
    resources: () => [state.firmware],
    refresh: () => Promise.all([
      load(state.firmware, api.firmware),
      // Whether the release that was just uploaded has been deployed since.
      state.upload.stage === 'done' ? load(state.deployments, api.deployments) : null,
    ]),
    interval: () => IDLE_REFRESH_MS,
    // A release that changes under an open dialog or a file in hand can wait for a moment.
    holdStill: () => dialogOpen() || uploadInHand(state.upload.stage),
  },
  deployments: {
    title: 'Deployments',
    view: deploymentsView,
    resources: () => [state.deployments],
    async refresh(full) {
      await Promise.all([
        load(state.deployments, api.deployments),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
      ]);
      // Which waiting board needs its button pressed, and which boards are online.
      if ((state.deployments.value ?? []).some(isUnderWay)) await load(state.devices, api.devices);
    },
    interval() {
      const devices = state.devices.value?.devices ?? [];
      return pollInterval((state.deployments.value ?? []).map((item) => summaryActivity(item, devices)));
    },
  },
  deployment: {
    title(route) {
      const version = versionOfDeployment(route.id);
      return version ? `Deployment of ${version}` : 'Deployment';
    },
    view: deploymentView,
    resources: () => [entry(state.deploymentDetails, state.route.id)],
    async refresh(full) {
      const { id } = state.route;
      const target = entry(state.deploymentDetails, id);
      const before = phasesOf(target.value);
      await Promise.all([
        load(target, () => api.deployment(id)),
        // Whether the release is still there to be offered again, or was revoked.
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
      ]);
      const detail = target.value;
      // The board list adds when an offline board was last seen and what it runs now.
      // It only needs reading again when a board has moved on, or may be about to.
      const moved = phasesOf(detail) !== before || (detail !== null && settling(detail));
      if (full || state.devices.loadedAt === 0 || moved) await load(state.devices, api.devices);
      // A board that runs what was cancelled may have got it from another deployment.
      // Its own list of updates says, and the deployment's record does not. A copy from
      // before the board ran it cannot say, and a read that failed is tried again.
      const runningIt = (detail?.executions ?? []).filter((execution) =>
        execution.status === 'CANCELED' && execution.reported === detail.version);
      await each(runningIt, (execution) => {
        const known = entry(state.deviceDetails, execution.thing);
        const outdated = known.error !== null || known.value?.device.fw?.version !== execution.reported;
        return full || outdated ? load(known, () => api.device(execution.thing)) : null;
      });
      // Who cancelled it is in the log and not in the deployment's record.
      if (detail?.status === 'CANCELED' && due(state.audit, full)) {
        await load(state.audit, () => api.audit({ limit: ACTIVITY_PAGE }));
      }
    },
    interval() {
      const detail = state.deploymentDetails.get(state.route.id)?.value;
      if (!detail) return 0;
      const statuses = detail.executions.map(executionActivity);
      if (settling(detail)) statuses.push('IN_PROGRESS');
      // While it can be offered again, somebody else can revoke its release: the page would then say so.
      return pollInterval(statuses) || (canBeOfferedAgain(detail) ? IDLE_REFRESH_MS : 0);
    },
  },
  activity: {
    title: 'Activity',
    view: activityView,
    resources: () => [state.audit],
    async refresh(full) {
      await Promise.all([
        load(state.audit, () => api.audit({ limit: ACTIVITY_PAGE })),
        // How a deployment ended is not in the log: it follows from the deployment.
        due(state.deployments, full) ? load(state.deployments, api.deployments) : null,
      ]);
    },
    interval: () => IDLE_REFRESH_MS,
    // Reading the first page again would take away the pages loaded by hand.
    holdStill: () => state.audit.loadingMore || (state.audit.value?.entries.length ?? 0) > ACTIVITY_PAGE,
  },
  // These two load their script when they are opened, so a cold load stays at five requests.
  // The serial console talks to a board and never to the API.
  serial: {
    title: 'Serial console',
    view: (ctx) => (serialScript ? serialScript.serialView(ctx) : scriptPending(ctx, 'serial', 'Serial console')),
    resources: () => [],
    async refresh() {
      serialScript ??= await pageScript(() => import('./serial.js'));
      draw();
    },
    interval: () => 0,
    painted: () => serialScript?.keepTranscriptInView(),
  },
  history: {
    title: 'History',
    view: (ctx) => (historyScript ? historyScript.historyView(ctx) : scriptPending(ctx, 'history', 'History')),
    resources: () => [state.commits],
    async refresh() {
      historyScript ??= await pageScript(() => import('./history.js'));
      if (historyScript && !state.commits.value) {
        await load(state.commits, () => historyScript.readHistory(window.fetch.bind(window)));
      }
      draw();
    },
    interval: () => 0,
  },
};

let serialScript = null;
let historyScript = null;

/** The script of a page, or null if it could not be fetched: after a deployment an old tab's is gone. */
async function pageScript(fetching) {
  try {
    state.scriptFailed = false;
    return await fetching();
  } catch (error) {
    console.error(error);
    state.scriptFailed = true;
    return null;
  }
}

// Refreshing. One timer, armed after each refresh has finished, so requests never
// pile up; none while the tab is hidden.

let timer = 0;
let turn = 0;

function arm() {
  clearTimeout(timer);
  if (state.gate) return;
  const page = pages[state.route.view];
  const plan = refreshPlan({
    interval: page.interval(),
    failed: page.resources().some((item) => item.error),
    visible: document.visibilityState === 'visible',
  });
  state.interval = plan.every;
  if (plan.wait > 0) timer = setTimeout(() => (page.holdStill?.() ? arm() : refreshNow(false)), plan.wait);
  draw();
}

async function refreshNow(full) {
  turn += 1;
  const mine = turn;
  clearTimeout(timer);
  await pages[state.route.view].refresh(full);
  if (mine === turn) arm();
}

// Sign-in.

function beginSignIn() {
  if (state.gate?.leaving) return;
  showGate({ iconName: 'lock', title: 'Taking you to the sign-in page…', leaving: true });
  auth.signIn(location.hash).catch((error) => {
    console.error(error);
    showGate(signedOutGate({ reason: 'cannot-start' }));
  });
}

function signedOutGate({ reason, message }) {
  const action = { label: 'Sign in', run: beginSignIn };
  switch (reason) {
    case 'signed-out':
      return { title: 'You are signed out', text: 'Sign in again to use the console.', action };
    case 'unknown-reply':
      return {
        title: 'That sign-in did not start here',
        text: 'The reply from the sign-in page did not belong to a sign-in started in this tab, ' +
          'so it was discarded unused.',
        action,
      };
    case 'login-error':
      return {
        iconName: 'alert',
        title: 'Sign-in was not completed',
        text: 'The sign-in page sent you back without signing you in.',
        detail: message ? 'The reason it gave:' : null,
        code: message,
        action,
      };
    case 'no-token':
      return {
        iconName: 'alert',
        title: 'Sign-in could not be completed',
        text: message,
        action: { ...action, label: 'Try again' },
      };
    case 'refused':
      return {
        iconName: 'alert',
        title: 'The server did not accept this sign-in',
        text: 'You signed in, but the console’s API turned the new session away. Signing in again ' +
          'will not help; whoever deployed the console needs to look at its API.',
        action: { label: 'Sign out', run: () => auth.signOut(), quiet: true },
      };
    default:
      return {
        iconName: 'alert',
        title: 'This browser cannot sign in here',
        text: 'The console needs session storage and a secure (HTTPS) page to sign in. ' +
          'Check that neither is blocked.',
      };
  }
}

function onUnauthorized() {
  // Whatever time it had left: the masthead, a dialog and the next request all go by this.
  auth.tokenRefused();
  const step = afterUnauthorized({
    gate: state.gate,
    fresh: auth.signedInWithin(FRESH_SIGN_IN_S),
    holding: dialogOpen() || uploadInHand(state.upload.stage),
  });
  // The masthead says that the session is over now, not at its next redraw.
  draw();
  if (step === 'refused') showGate(signedOutGate({ reason: 'refused' }));
  else if (step === 'sign-in') beginSignIn();
}

/** Leave for the sign-in page shortly before the token ends, unless work is in hand. */
function checkSession() {
  const renew = shouldRenew({
    needsRenewal: auth.needsRenewal(),
    visible: document.visibilityState === 'visible',
    gate: Boolean(state.gate),
    dialogOpen: dialogOpen(),
    uploadStage: state.upload.stage,
  });
  if (renew) beginSignIn();
}

/**
 * Another tab was signed out. This one ends too, whatever it holds: the point of signing
 * out is that nobody can go on from here. What a file or a dialog had in hand is gone.
 */
function signedOutElsewhere() {
  if (!auth) return;
  auth.signedOutElsewhere();
  chosen += 1;
  state.upload = { stage: 'idle', over: false };
  showGate(signedOutGate({ reason: 'signed-out' }));
}

/** The line between tabs of this address. A browser without one simply has none. */
function openSessionChannel() {
  if (typeof window.BroadcastChannel !== 'function') return null;
  try {
    const channel = new window.BroadcastChannel(SESSION_CHANNEL);
    channel.addEventListener('message', (event) => {
      if (event.data === SIGNED_OUT_SIGNAL) signedOutElsewhere();
    });
    return channel;
  } catch {
    return null;
  }
}

// Routes.

let routesShown = 0;

// How far the reader had scrolled, by entry of the browser's history, for the Back and
// Forward buttons. A link makes an entry without a mark, which it gets here.
const scrolled = new Map();
let entriesMarked = 0;

function placePage() {
  const mark = history.state?.entry ?? null;
  window.scrollTo(0, scrolled.get(mark) ?? 0);
  if (mark === null) {
    entriesMarked += 1;
    history.replaceState({ entry: `${Date.now()}-${entriesMarked}` }, '', location.pathname + location.hash);
  }
}

function showRoute() {
  if (state.gate) return;
  const route = parseRoute(location.hash);
  if (!route) {
    // A console that opens without an address has simply been opened. Any other address
    // was meant to lead somewhere, and leading elsewhere without a word would be odd.
    const lost = !['', '#', '#/'].includes(location.hash);
    history.replaceState(null, '', location.pathname + routeHash(null));
    if (lost) notify('That address is not a page of this console. Here is the overview.');
    showRoute();
    return;
  }
  if (dialog) dialog.close(true);
  state.route = route;
  state.interval = 0;
  const { title } = pages[route.view];
  document.title = `${typeof title === 'function' ? title(route) : title} · Cranium`;
  paint();
  placePage();
  // Moving between pages puts the focus on the new page's title, where reading and
  // tabbing should go on. The first page is left alone: it starts at the top.
  routesShown += 1;
  if (routesShown > 1) document.getElementById('page-title')?.focus({ preventScroll: true });
  refreshNow(true);
}

// Dialogs. One at a time; Escape and the backdrop close it unless a request is under way.

function dialogOpen() {
  return dialog !== null && dialog.isOpen();
}

function openDialog(build) {
  const el = document.createElement('dialog');
  el.className = 'dialog';
  el.setAttribute('aria-labelledby', 'dialog-title');
  document.body.append(el);

  let pressedOutside = false;
  const openedAt = Date.now();
  const self = {
    busy: false,
    isOpen: () => el.open,
    redraw: () => keepingFocus(() => render(el, build())),
    close(force = false) {
      if (!self.busy || force) el.close();
    },
  };
  el.addEventListener('cancel', (event) => {
    if (self.busy) event.preventDefault();
  });
  el.addEventListener('mousedown', (event) => {
    pressedOutside = event.target === el;
  });
  el.addEventListener('click', (event) => {
    if (pressedOutside && event.target === el && Date.now() - openedAt > DOUBLE_CLICK_MS) self.close();
  });
  el.addEventListener('close', () => {
    el.remove();
    if (dialog === self) dialog = null;
    // The browser gives the focus back to what opened the dialog, unless that is gone.
    if (document.activeElement === document.body) {
      document.getElementById('page-title')?.focus({ preventScroll: true });
    }
    checkSession();
  });

  dialog = self;
  self.redraw();
  el.showModal();
  // A dialog opens at its top, also where the field that gets the focus lies further down.
  el.scrollTop = 0;
  const body = el.querySelector?.('.dialog-body');
  if (body) body.scrollTop = 0;
  return self;
}

async function submitFrom(self, model, task) {
  model.sending = true;
  model.error = null;
  self.busy = true;
  self.redraw();
  try {
    await task();
  } catch (error) {
    model.error = asProblem(error);
    model.sending = false;
    self.busy = false;
    self.redraw();
    // The change may have been made all the same, or the server said that the page is
    // out of date: show what is true now. The open dialog is drawn again with the page.
    if (staleAfter(model.error)) refreshNow(true);
  }
}

function openDeploy(version) {
  if (!state.me.canWrite || dialogOpen()) return;
  let self = null;
  const change = (apply) => (...args) => {
    apply(...args);
    model.error = null;
    self.redraw();
  };
  // With a single board to choose from, it is ticked when the boards come up. From the
  // first tick by hand on, the selection is the user's own.
  const suggest = () => {
    if (model.chosenByHand || model.step !== 1 || model.devices === null) return;
    const only = onlyChoice(model.devices, model.busy, model.version);
    model.things = new Set(only === null ? [] : [only]);
  };
  const model = {
    step: version ? 1 : 0,
    version,
    things: new Set(),
    chosenByHand: false,
    note: '',
    busy: new Map(),
    releases: null,
    devices: null,
    loading: true,
    loadError: null,
    sending: false,
    error: null,
    // The release that was asked for and has been revoked since.
    gone: null,
    close: () => self.close(),
    signIn: beginSignIn,
    choose: change((picked) => {
      model.version = picked;
      model.gone = null;
    }),
    next: change(() => {
      model.step += 1;
      suggest();
    }),
    back: change(() => { model.step -= 1; }),
    setNote(text) {
      model.note = text;
    },
    toggle: change((thing) => {
      model.chosenByHand = true;
      if (model.things.has(thing)) model.things.delete(thing);
      else if (!model.busy.has(thing)) model.things.add(thing);
    }),
    toggleAll: change(() => {
      model.chosenByHand = true;
      // Not the boards that would only refuse: those take a tick of their own.
      const free = model.devices.filter((device) =>
        !model.busy.has(device.thing) && !alreadyRuns(device, model.version));
      const all = free.every((device) => model.things.has(device.thing));
      model.things = new Set(all ? [] : [...model.things, ...free.map((device) => device.thing)]);
    }),
    async reload() {
      model.loading = true;
      model.loadError = null;
      self.redraw();
      try {
        const [firmware, fleet] = await Promise.all([api.firmware(), api.devices()]);
        // What this has found out is true of the page behind the dialog as well.
        Object.assign(state.firmware, { value: firmware, error: null, loadedAt: clock.now() });
        draw();
        // Whether a board still has an update open is in the board's own record.
        const busy = new Map();
        await each(fleet.devices, async (device) => {
          const detail = await api.device(device.thing);
          const open = detail.executions.find((execution) => isUnfinished(execution.status));
          if (open) {
            busy.set(device.thing, {
              deployment: open.deployment,
              version: open.version ?? versionOfDeployment(open.deployment),
            });
          }
        });
        model.releases = firmware.releases.filter((release) => release.status === 'active');
        model.devices = fleet.devices;
        model.busy = busy;
        for (const thing of [...model.things]) {
          if (busy.has(thing)) model.things.delete(thing);
        }
        if (!model.releases.some((release) => release.version === model.version)) {
          // Without a word on which release, the newest is the one to suggest. A release
          // that was asked for and has gone is not silently replaced by another.
          model.gone = model.version;
          model.version = model.gone === null ? model.releases[0]?.version ?? null : null;
          model.step = 0;
        }
        suggest();
      } catch (error) {
        model.loadError = asProblem(error);
      }
      model.loading = false;
      self.redraw();
    },
    submit: () => submitFrom(self, model, async () => {
      let deployment;
      try {
        deployment = await api.deploy({
          version: model.version,
          things: [...model.things].sort(),
          note: singleLine(model.note),
        });
      } catch (error) {
        // A conflict says that what the dialog offers is out of date: a board has become
        // busy, or the release was revoked. Read both again, so that neither can be
        // chosen once more, and go back to the boards where a busy one is named.
        if (error?.status === 409) {
          if (error.code === 'device_busy') model.step = 1;
          model.reload();
        }
        throw error;
      }
      keep(state.deploymentDetails, deployment.id, deployment);
      self.close(true);
      notify(`Deployment of ${deployment.version ?? model.version} started.`);
      location.hash = routeHash({ view: 'deployment', id: deployment.id });
    }),
  };
  self = openDialog(() => deployDialog(model, { state, actions }));
  model.reload();
}

function openCancel(deployment) {
  if (!state.me.canWrite || dialogOpen() || !deployment) return;
  let self = null;
  const model = {
    // The dialog counts waiting and started boards from the newest record there is.
    get deployment() {
      return state.deploymentDetails.get(deployment.id)?.value ?? deployment;
    },
    force: false,
    sending: false,
    error: null,
    close: () => self.close(),
    signIn: beginSignIn,
    setForce(force) {
      model.force = force;
      self.redraw();
    },
    // `force` is what the dialog shows as chosen, which is not always what was ticked:
    // once the offer is withdrawn, stopping the boards is all that is left.
    submit: (force) => submitFrom(self, model, async () => {
      const before = model.deployment;
      const started = before.executions.filter((execution) => execution.status === 'IN_PROGRESS').length;
      const updated = await api.cancel(deployment.id, force);
      keep(state.deploymentDetails, updated.id, updated);
      self.close(true);
      notify(cancelNotice({ force, withdrawn: before.status === 'CANCELED', started }));
      refreshNow(true);
    }),
  };
  self = openDialog(() => cancelDialog(model));
}

// The API wants a reason with every revocation. One that is repeated carries the
// reason on record; this stands in for a record that has none.
const REPEATED_REASON = 'Revocation applied again.';

/**
 * Revoke a release, or repeat the revocation of one that is revoked already. The
 * second finishes a revocation that stopped half way: the server then repeats the steps
 * after the mark, which refuse the image and cancel the open deployments.
 */
function openRevoke(release) {
  if (!state.me.canWrite || dialogOpen()) return;
  let self = null;
  const model = {
    // The newest record of the release there is: a first attempt that failed half way
    // leaves it revoked, and the dialog then offers to finish.
    get release() {
      return state.firmware.value?.releases.find((item) => item.version === release.version) ?? release;
    },
    get again() {
      return model.release.status !== 'active';
    },
    reason: '',
    // Typing starts in the reason, except on a touch screen, where the keyboard would
    // cover what the dialog has to say.
    focusReason: !window.matchMedia('(pointer: coarse)').matches,
    sending: false,
    error: null,
    close: () => self.close(),
    signIn: beginSignIn,
    setReason(text) {
      model.reason = text;
      self.redraw();
    },
    submit: () => submitFrom(self, model, async () => {
      const { again } = model;
      const reason = again
        ? singleLine(model.release.revoked?.reason) || REPEATED_REASON
        : singleLine(model.reason);
      let cancelled = null;
      try {
        const done = await api.revoke(release.version, reason);
        ({ cancelled } = done);
        const firmware = state.firmware.value;
        if (firmware) {
          firmware.releases = firmware.releases.map((item) =>
            (item.version === done.release.version ? done.release : item));
        }
      } catch (error) {
        // The server found the release revoked and went through the steps after the
        // mark without a failure. That is what was asked for, answered as a refusal.
        if (!revocationInPlace(error)) throw error;
      }
      self.close(true);
      refreshNow(true);
      // Said at once: this cannot be undone, and its confirmation does not wait for a list.
      notify(revocationNotice(release.version, { cancelled, again }));
      // Revoking leaves a board that runs the release as it is. Whoever revokes should know
      // which, as soon as that is known.
      await load(state.devices, api.devices);
      const running = (state.devices.value?.devices ?? []).filter((device) => device.fw?.version === release.version);
      if (running.length > 0) notify(stillRunning(running));
    }),
  };
  self = openDialog(() => revokeDialog(model, { state, actions }));
}

// Uploading firmware.

let chosen = 0;

async function chooseFile(file) {
  chosen += 1;
  const mine = chosen;
  const name = String(file.name);
  if (file.size > LARGEST_FILE_READ) {
    state.upload = {
      stage: 'ready',
      name,
      recordedAs: recordedFilename(name),
      size: file.size,
      digest: '',
      header: { ok: false, message: 'This file is far too large to be firmware for the board.' },
      notes: '',
    };
    draw();
    return;
  }
  state.upload = { stage: 'reading', name };
  draw();
  let bytes;
  let digest;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    digest = await sha256Hex(bytes);
  } catch (error) {
    console.error(error);
    if (mine === chosen) {
      state.upload = {
        stage: 'ready', name, recordedAs: recordedFilename(name), size: file.size, digest: '', notes: '',
        header: { ok: false, message: 'The file could not be read.' },
      };
      draw();
    }
    return;
  }
  if (mine !== chosen) return;
  state.upload = {
    stage: 'ready',
    name,
    recordedAs: recordedFilename(name),
    size: bytes.length,
    bytes,
    digest,
    header: readImageHeader(bytes),
    notes: '',
  };
  if (state.firmware.loadedAt === 0) load(state.firmware, api.firmware);
  draw();
}

async function startUpload() {
  const upload = state.upload;
  if (upload.stage !== 'ready' && upload.stage !== 'refused') return;
  state.upload = { ...upload, stage: 'sending', sent: 0, error: null };
  draw();
  try {
    const release = await api.upload(
      { filename: upload.recordedAs, notes: singleLine(upload.notes), data: toBase64(upload.bytes) },
      (progress) => {
        if (state.upload.stage !== 'sending' && state.upload.stage !== 'checking') return;
        state.upload = { ...state.upload, stage: progress.stage, sent: progress.sent };
        draw();
      });
    // The panel itself says "Registered as …"; a toast on top of the list would only repeat it.
    state.upload = { stage: 'done', release };
    load(state.firmware, api.firmware);
  } catch (error) {
    state.upload = { ...upload, stage: 'refused', error: asProblem(error) };
    draw();
    load(state.firmware, api.firmware);
  }
}

const actions = {
  refresh: () => refreshNow(true),
  redraw: draw,
  signOut: () => auth.signOut(),
  // Asked for by hand where the console does not leave by itself: with a file in hand.
  signInAgain: () => beginSignIn(),
  async copy(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      notify(`Copied ${label}.`);
    } catch {
      notify(`Could not copy ${label}. Select the text and copy it by hand.`, 'bad');
    }
  },
  chooseFile,
  startUpload,
  resetUpload() {
    chosen += 1;
    state.upload = { stage: 'idle', over: false };
    draw();
  },
  setUploadNotes(text) {
    state.upload.notes = text;
  },
  dragOver(event) {
    event.preventDefault();
    if (!state.upload.over) {
      state.upload = { ...state.upload, over: true };
      draw();
    }
  },
  dragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    state.upload = { ...state.upload, over: false };
    draw();
  },
  dropFile(event) {
    event.preventDefault();
    const [file] = event.dataTransfer?.files ?? [];
    state.upload = { ...state.upload, over: false };
    if (file) chooseFile(file);
    else draw();
  },
  openDeploy,
  openCancel,
  openRevoke,
  async loadMoreActivity() {
    const audit = state.audit;
    if (!audit.value?.next || audit.loadingMore) return;
    audit.loadingMore = true;
    draw();
    try {
      const page = await api.audit({ limit: ACTIVITY_PAGE, before: audit.value.next });
      audit.value = { entries: audit.value.entries.concat(page.entries), next: page.next };
      audit.moreError = null;
    } catch (error) {
      audit.moreError = asProblem(error);
    }
    audit.loadingMore = false;
    draw();
  },
};

// Starting up.

async function start() {
  try {
    state.me = await api.me();
  } catch (error) {
    if (error?.status === 401) return;
    const fault = asProblem(error);
    const gate = fault.code === 'account_inactive'
      ? {
        title: 'Your account is not active',
        text: 'It is disabled or removed, or it has not been confirmed. Ask a teammate who manages the console.',
        action: { label: 'Sign out', run: () => auth.signOut(), quiet: true },
      }
      : null;
    showGate(gate ?? (fault.status === 403
      ? {
        title: 'Your account has no access yet',
        text: 'You are signed in, but your account is in neither the viewers nor the release ' +
          'managers group. Ask a teammate who manages the console to add you.',
        detail: fault.message,
        action: { label: 'Sign out', run: () => auth.signOut(), quiet: true },
      }
      : {
        iconName: 'alert',
        title: 'The console could not reach its server',
        text: fault.message,
        action: {
          label: 'Try again',
          run() {
            showGate({ iconName: 'clock', title: 'Loading the console…', waiting: true });
            start();
          },
        },
      }));
    return;
  }
  state.gate = null;

  window.addEventListener('hashchange', showRoute);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      clearTimeout(timer);
      return;
    }
    checkSession();
    if (!state.gate && pages[state.route.view].interval() > 0) refreshNow(false);
  });
  // A file dropped beside the drop zone must not make the browser open it.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  setInterval(() => {
    if (document.visibilityState === 'visible') draw();
  }, REDRAW_MS);
  setInterval(checkSession, SESSION_CHECK_MS);

  showRoute();
}

async function boot() {
  // The console puts each page where it belongs: see placePage().
  history.scrollRestoration = 'manual';
  window.addEventListener('scroll', () => {
    const mark = history.state?.entry;
    if (mark) scrolled.set(mark, window.scrollY);
  }, { passive: true });
  document.getElementById('skip')?.addEventListener('click', () => {
    (document.getElementById('page-title') ?? main).focus();
  });
  // A page brought back by the Back button is a snapshot from before the browser left,
  // perhaps for the sign-in page or after signing out. Start again from what is true now.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });

  const config = readConfig(document.querySelector('meta[name="cranium-config"]')?.content);
  if (!config) {
    showGate({
      iconName: 'alert',
      title: 'The console is not set up',
      text: 'The page arrived without its sign-in settings. Reload it; if that does not help, ' +
        'the console needs to be deployed again.',
    });
    return;
  }

  const channel = openSessionChannel();
  let outcome;
  try {
    auth = createAuth({
      config,
      storage: window.sessionStorage,
      location: window.location,
      history: window.history,
      fetch: window.fetch.bind(window),
      crypto: window.crypto,
      tellOtherTabs: () => channel?.postMessage(SIGNED_OUT_SIGNAL),
    });
    api = createApi({
      auth,
      fetch: window.fetch.bind(window),
      XMLHttpRequest: window.XMLHttpRequest,
      crypto: window.crypto,
      clock,
      onUnauthorized,
    });
    outcome = await auth.resume(location.hash);
  } catch (error) {
    console.error(error);
    showGate(signedOutGate({ reason: 'cannot-start' }));
    return;
  }

  if (outcome.status === 'redirecting') {
    showGate({ iconName: 'lock', title: 'Taking you to the sign-in page…', leaving: true });
    return;
  }
  if (outcome.status === 'signed-out') {
    showGate(signedOutGate(outcome));
    return;
  }
  if (outcome.route) history.replaceState(null, '', location.pathname + outcome.route);
  auth.revocation().then((result) => {
    if (result === 'failed' || result === 'refused') {
      notify('The sign-in service did not confirm that the unused refresh token was revoked. ' +
        'It expires by itself within the hour.', 'bad');
    }
  });
  await start();
}

boot();
