/**
 * The console's entry point: signing in, following the address bar, loading and
 * refreshing what each page shows, and the dialogs that change something.
 *
 * State lives in one object. Whenever it changes the page is drawn again from it;
 * views.js makes that cheap. Requests are refreshed on a schedule that follows what
 * the boards are doing and stops while the tab is in the background.
 */

import {
  ApiError, createApi, createAuth, createClock, deviceActivity, isUnfinished, parseRoute, plural,
  pollInterval, readConfig, readImageHeader, recordedFilename, routeHash, sha256Hex, singleLine,
  summaryActivity, toBase64, versionOfDeployment,
} from './core.js';
import {
  accountView, activityView, cancelDialog, deployDialog, deploymentView, deploymentsView, deviceView,
  devicesView, firmwareView, gateView, navView, overviewView, render, revokeDialog,
} from './views.js';

// Board lists are also refreshed when nothing is being installed, so that "online"
// does not go stale. Deployments are not: they follow pollInterval() alone.
const IDLE_REFRESH_MS = 30000;
const RETRY_AFTER_ERROR_MS = 15000;
const REDRAW_MS = 15000;
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
  render(main, node);
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

function notify(message, tone = 'good') {
  const toast = document.createElement('div');
  toast.className = `toast is-${tone}`;
  toast.textContent = message;
  toasts.append(toast);
  setTimeout(() => toast.remove(), tone === 'good' ? 5000 : 12000);
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

function activeDeployments() {
  return (state.deployments.value ?? [])
    .filter((deployment) => deployment.status === 'IN_PROGRESS')
    .slice(0, DEPLOYMENTS_ON_OVERVIEW);
}

function phasesOf(deployment) {
  if (!deployment) return '';
  return deployment.executions.map((execution) => `${execution.thing}:${execution.phase}`).join(' ');
}

// One entry per page: how it is drawn, what it loads, and how soon to load it again
// (0 for never). `full` is false for a scheduled refresh, which skips what cannot
// have changed much.
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
      await each(activeDeployments(), (deployment) =>
        load(entry(state.deploymentDetails, deployment.id), () => api.deployment(deployment.id)));
    },
    interval() {
      const statuses = (state.devices.value?.devices ?? []).map(deviceActivity);
      for (const deployment of activeDeployments()) {
        const detail = state.deploymentDetails.get(deployment.id)?.value;
        if (detail) statuses.push(...detail.executions.map((execution) => execution.status));
        else statuses.push(summaryActivity(deployment));
      }
      return pollInterval(statuses) || IDLE_REFRESH_MS;
    },
  },
  devices: {
    title: 'Devices',
    view: devicesView,
    resources: () => [state.devices],
    refresh: () => load(state.devices, api.devices),
    interval: () => pollInterval((state.devices.value?.devices ?? []).map(deviceActivity)) || IDLE_REFRESH_MS,
  },
  device: {
    title: 'Board',
    view: deviceView,
    resources: () => [entry(state.deviceDetails, state.route.thing)],
    refresh() {
      const { thing } = state.route;
      return load(entry(state.deviceDetails, thing), () => api.device(thing));
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
    refresh: () => load(state.firmware, api.firmware),
    interval: () => 0,
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
    },
    interval: () => pollInterval((state.deployments.value ?? []).map(summaryActivity)),
  },
  deployment: {
    title: 'Deployment',
    view: deploymentView,
    resources: () => [entry(state.deploymentDetails, state.route.id)],
    async refresh(full) {
      const { id } = state.route;
      const target = entry(state.deploymentDetails, id);
      const before = phasesOf(target.value);
      await load(target, () => api.deployment(id));
      // The board list adds when an offline board was last seen and what it runs now.
      // It only needs reading again when a board has moved on.
      if (full || state.devices.loadedAt === 0 || phasesOf(target.value) !== before) {
        await load(state.devices, api.devices);
      }
    },
    interval() {
      const detail = state.deploymentDetails.get(state.route.id)?.value;
      return detail ? pollInterval(detail.executions.map((execution) => execution.status)) : 0;
    },
  },
  activity: {
    title: 'Activity',
    view: activityView,
    resources: () => [state.audit],
    refresh: () => load(state.audit, () => api.audit({ limit: ACTIVITY_PAGE })),
    interval: () => 0,
  },
};

// Refreshing. One timer, armed after each refresh has finished, so requests never
// pile up; none while the tab is hidden.

let timer = 0;
let turn = 0;

function arm() {
  clearTimeout(timer);
  if (state.gate) return;
  const page = pages[state.route.view];
  let delay = page.interval();
  if (delay > 0 && page.resources().some((item) => item.error)) delay = Math.max(delay, RETRY_AFTER_ERROR_MS);
  state.interval = delay;
  if (delay > 0 && document.visibilityState === 'visible') {
    timer = setTimeout(() => refreshNow(false), delay);
  }
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
  // A message that is already about signing in stays; one that only says "loading" does not.
  if (state.gate && !state.gate.waiting) return;
  if (auth.signedInWithin(FRESH_SIGN_IN_S)) showGate(signedOutGate({ reason: 'refused' }));
  else beginSignIn();
}

function checkSession() {
  if (state.gate || document.visibilityState !== 'visible') return;
  // A dialog is left alone; if the token runs out under it, the next request says so.
  if (auth.needsRenewal() && !dialogOpen()) beginSignIn();
}

// Routes.

let routesShown = 0;

function showRoute() {
  if (state.gate) return;
  const route = parseRoute(location.hash);
  if (!route) {
    history.replaceState(null, '', location.pathname + routeHash(null));
    showRoute();
    return;
  }
  if (dialog) dialog.close(true);
  state.route = route;
  state.interval = 0;
  document.title = `${pages[route.view].title} · Cranium`;
  paint();
  window.scrollTo(0, 0);
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
  const self = {
    busy: false,
    isOpen: () => el.open,
    redraw: () => render(el, build()),
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
    if (pressedOutside && event.target === el) self.close();
  });
  el.addEventListener('close', () => {
    el.remove();
    if (dialog === self) dialog = null;
    checkSession();
  });

  dialog = self;
  self.redraw();
  el.showModal();
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
    // Unless the server said no, the change may have been made: show what is true now.
    if (!(model.error.status >= 400 && model.error.status < 500)) refreshNow(true);
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
  const model = {
    step: version ? 1 : 0,
    version,
    things: new Set(),
    note: '',
    busy: new Map(),
    releases: null,
    devices: null,
    loading: true,
    loadError: null,
    sending: false,
    error: null,
    close: () => self.close(),
    choose: change((picked) => { model.version = picked; }),
    next: change(() => { model.step += 1; }),
    back: change(() => { model.step -= 1; }),
    setNote(text) {
      model.note = text;
    },
    toggle: change((thing) => {
      if (model.things.has(thing)) model.things.delete(thing);
      else if (!model.busy.has(thing)) model.things.add(thing);
    }),
    toggleAll: change(() => {
      const free = model.devices.filter((device) => !model.busy.has(device.thing));
      const all = free.every((device) => model.things.has(device.thing));
      model.things = new Set(all ? [] : free.map((device) => device.thing));
    }),
    async reload() {
      model.loading = true;
      model.loadError = null;
      self.redraw();
      try {
        const [firmware, fleet] = await Promise.all([api.firmware(), api.devices()]);
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
          model.version = model.releases[0]?.version ?? null;
          model.step = 0;
        }
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
        // Back to the boards, where the busy ones are named.
        if (error?.code === 'device_busy') model.step = 1;
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
    setForce(force) {
      model.force = force;
      self.redraw();
    },
    submit: () => submitFrom(self, model, async () => {
      const updated = await api.cancel(deployment.id, model.force);
      keep(state.deploymentDetails, updated.id, updated);
      self.close(true);
      notify(model.force
        ? 'Cancelled. Boards that had started are being stopped.'
        : 'Cancelled. Boards that had not started are no longer offered this update.');
      refreshNow(true);
    }),
  };
  self = openDialog(() => cancelDialog(model));
}

function openRevoke(release) {
  if (!state.me.canWrite || dialogOpen()) return;
  let self = null;
  const model = {
    release,
    reason: '',
    sending: false,
    error: null,
    close: () => self.close(),
    setReason(text) {
      model.reason = text;
      self.redraw();
    },
    submit: () => submitFrom(self, model, async () => {
      const { release: revoked, cancelled } = await api.revoke(release.version, singleLine(model.reason));
      const firmware = state.firmware.value;
      if (firmware) {
        firmware.releases = firmware.releases.map((item) =>
          (item.version === revoked.version ? revoked : item));
      }
      self.close(true);
      const stopped = plural(cancelled.length, 'unfinished deployment was', 'unfinished deployments were');
      notify(cancelled.length > 0
        ? `Revoked ${revoked.version}. ${stopped} cancelled.`
        : `Revoked ${revoked.version}. No deployment of it was still open.`);
      refreshNow(true);
    }),
  };
  self = openDialog(() => revokeDialog(model));
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
    state.upload = { stage: 'done', release };
    notify(`${release.version} is registered.`);
    load(state.firmware, api.firmware);
  } catch (error) {
    state.upload = { ...upload, stage: 'refused', error: asProblem(error) };
    draw();
    load(state.firmware, api.firmware);
  }
}

const actions = {
  refresh: () => refreshNow(true),
  signOut: () => auth.signOut(),
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
    showGate(fault.status === 403
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
      });
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

  let outcome;
  try {
    auth = createAuth({
      config,
      storage: window.sessionStorage,
      location: window.location,
      history: window.history,
      fetch: window.fetch.bind(window),
      crypto: window.crypto,
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
