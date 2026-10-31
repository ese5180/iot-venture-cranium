/**
 * The serial console: a board on a USB cable, driven from this page with Web Serial.
 *
 * Nothing here talks to the API. What is typed goes over the cable to the board and
 * nowhere else, and what the board says stays in this tab's memory.
 *
 * The board's protocol is firmware/app/src/console_cmd.c: one command per line, of the
 * form COMMAND|arg1|arg2. A command's reply ends with exactly one final line, OK ... or
 * ERR ...; a line that starts with [TAG] is a log line or an event and can come at any
 * time. COMMANDS below is the one table the forms, the free input and the masking are
 * made from, and its rules are the firmware's: same limits, counted the same way, in
 * the same words.
 *
 * A Wi-Fi password is never shown, stored or kept. The transcript holds a masked copy of
 * a command, and the history leaves such a command out. The line that goes to the board
 * lives only in the call that writes it, and its bytes are overwritten afterwards. The
 * board echoes what it receives until it is told not to, and starts doing so again
 * whenever it restarts, so it is told again right before anything that holds a password,
 * and what comes back is masked as well.
 *
 * Loaded when the page is first opened, so a cold load of the console stays as it was.
 *
 * No dependencies.
 */

import {
  button, developerTabs, empty, h, icon, mono, notice, pageHead,
} from './views.js';

const SEGGER_VENDOR_ID = 0x1366;
const BAUD_RATE = 115200;
// How long the board gets to answer before this is taken for the port without a console.
const PROBE_MS = 2000;
const REPLY_MS = 10000;
const RESTART_SETTLE_MS = 300;

// The firmware's limits: CONSOLE_LINE_MAX, DEVICE_ID_MAX, NET_SSID_MAX, NET_PASSWORD_MIN and _MAX.
const LINE_MAX = 384;
const ID_MAX = 32;
const SSID_MAX = 32;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 63;
// The firmware shows no more than this of a name it does not know.
const NAME_SHOWN_MAX = 32;

// What is kept in memory, however long the board goes on talking.
const LINES_KEPT = 1000;
const COMMANDS_KEPT = 50;
const PARTIAL_MAX = 4096;

export const MASK = '••••••';

const encoder = new TextEncoder();

function byteLength(text) {
  return encoder.encode(text).length;
}

// The reader's is_control(): a tab is allowed. Backspace and DEL would erase, and a line
// ending would start another command.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

// Rules. Each says what is wrong with a value, in the firmware's words, or null.

const RULES = {
  id(value) {
    return /^[0-9A-Za-z]{1,32}$/.test(value) ? null : `id must be 1-${ID_MAX} letters or digits`;
  },
  ssid(value) {
    const bytes = byteLength(value);
    if (bytes === 0 || bytes > SSID_MAX) return `ssid must be 1-${SSID_MAX} bytes`;
    // The firmware splits on it, so the rest of the name would become the password.
    if (value.includes('|')) return 'ssid cannot contain |';
    return CONTROL.test(value) ? 'ssid cannot contain a control character' : null;
  },
  password(value) {
    if (value === '') return 'open networks are not allowed';
    const bytes = byteLength(value);
    if (bytes < PASSWORD_MIN || bytes > PASSWORD_MAX) {
      return `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`;
    }
    return CONTROL.test(value) ? 'password cannot contain a control character' : null;
  },
};

// The table. `group` is the part of the page with its form, null for what can only be
// typed. `args` is the firmware's [min_args, max_args], `factory` its in_factory.

const ID_FIELD = { key: 'id', label: 'ID', rule: 'id', hint: `1 to ${ID_MAX} letters or digits.` };
const SSID_FIELD = { key: 'ssid', label: 'Network name', rule: 'ssid', hint: `1 to ${SSID_MAX} bytes, without a |.` };
const PASSWORD_FIELD = {
  key: 'password',
  label: 'Password',
  rule: 'password',
  secret: true,
  hint: `${PASSWORD_MIN} to ${PASSWORD_MAX} characters; open networks are not allowed. Cleared as soon as it is sent.`,
};
const SECURITY_FIELD = { key: 'security', label: 'Security', choices: ['WPA2_PSK', 'WPA2_PSK_SHA256', 'WPA3_SAE'] };
const SECTION_FIELD = {
  key: 'section', label: 'Section', optional: true, choices: ['', 'device', 'wifi', 'cloud', 'certs', 'update'],
};

export const COMMANDS = Object.freeze([
  { name: 'GET_ID', group: 'identity', factory: true, args: [0, 0], fields: [], text: 'Ask for the ID and the firmware version.' },
  { name: 'SET_ID', group: 'identity', factory: false, args: [1, 1], fields: [ID_FIELD], text: 'Change the ID and keep everything else.' },
  {
    name: 'INIT',
    group: 'identity',
    factory: true,
    args: [1, 1],
    fields: [ID_FIELD],
    confirm: 'INIT',
    text: 'First-time setup: erases everything on the board, stores the ID and restarts.',
  },
  { name: 'WIFI', group: 'wifi', factory: false, args: [2, 2], fields: [SSID_FIELD, PASSWORD_FIELD], text: 'Save a WPA2 network and join it.' },
  {
    name: 'WIFI_SEC',
    group: 'wifi',
    factory: false,
    args: [3, 3],
    fields: [SSID_FIELD, SECURITY_FIELD, PASSWORD_FIELD],
    text: 'The same, with the security mode named.',
  },
  { name: 'CLEAR_WIFI', group: 'wifi', factory: false, args: [0, 0], fields: [], text: 'Erase the network and disconnect.' },
  { name: 'NET', group: 'wifi', factory: false, args: [0, 0], fields: [], text: 'Show connection state, name, IP, signal and MAC.' },
  { name: 'STATS', group: 'status', factory: false, args: [0, 0], fields: [], text: 'State, ID, firmware, Wi-Fi, uptime, memory, last reset.' },
  { name: 'STATUS', group: 'status', factory: false, args: [0, 1], fields: [SECTION_FIELD], text: 'Print the configuration, or one section of it.' },
  { name: 'HELP', alias: '?', group: 'status', factory: true, args: [0, 0], fields: [], text: 'List the commands of this firmware.' },
  { name: 'REBOOT', group: 'maintenance', factory: true, args: [0, 0], fields: [], text: 'Restart the board.' },
  {
    name: 'ENTER_BOOTLOADER',
    group: 'maintenance',
    factory: true,
    args: [0, 0],
    fields: [],
    text: 'Restart; catch the bootloader with tools/recover.py --console.',
  },
  {
    name: 'RESET_CONFIG',
    group: 'maintenance',
    factory: false,
    args: [0, 0],
    fields: [],
    text: 'Clear the cloud settings only. Keeps the ID, Wi-Fi, certificates and key.',
  },
  {
    name: 'FACTORY_RESET',
    group: 'maintenance',
    factory: false,
    args: [0, 0],
    fields: [],
    confirm: 'FACTORY_RESET',
    text: 'Erase everything, also the ID, and restart in factory mode.',
  },
  { name: 'THING', group: null, factory: true, args: [0, 0], fields: [] },
  { name: 'ECHO', group: null, factory: true, args: [1, 1], fields: [] },
  { name: 'CLOUD', group: null, factory: false, args: [1, 2], fields: [] },
  { name: 'KEYGEN', group: null, factory: false, args: [0, 1], fields: [] },
  { name: 'STREAM_START', group: null, factory: false, args: [4, 4], fields: [] },
  { name: 'STREAM_CHUNK', group: null, factory: false, args: [2, 2], fields: [] },
  { name: 'STREAM_STATUS', group: null, factory: false, args: [0, 0], fields: [] },
  { name: 'STREAM_CANCEL', group: null, factory: false, args: [0, 0], fields: [] },
  { name: 'BUTTON', group: null, factory: false, args: [1, 1], fields: [] },
]);

const KNOWN = new Map(COMMANDS.flatMap((command) => [
  [command.name, command], ...(command.alias ? [[command.alias, command]] : []),
]));

const GROUPS = [
  ['identity', 'Identity'],
  ['wifi', 'Wi-Fi'],
  ['status', 'Status'],
  ['maintenance', 'Maintenance'],
];

// How many arguments come before the password.
const BEFORE_SECRET = { WIFI: 1, WIFI_SEC: 2 };

/** The name of the command on a line, in capitals: what the firmware compares. */
function commandName(line) {
  const bar = line.indexOf('|');
  return (bar < 0 ? line : line.slice(0, bar)).trim().toUpperCase();
}

/** Whether a line holds, or is on its way to holding, a Wi-Fi password. */
export function holdsSecret(line) {
  return Object.hasOwn(BEFORE_SECRET, commandName(line)) && line.includes('|');
}

/**
 * A command as it may be shown. The password of a Wi-Fi command is masked, and so is
 * anything that may be one because the fields are not what they should be: a password
 * can hold a |, so WIFI_SEC shows its fields only if the security mode is where it belongs.
 * Of a name that is not a command only the name is shown, the way the firmware treats it:
 * the rest could be anything, since a typo in WIFI is not a reason to show a password.
 */
export function shownCommand(line) {
  const text = line.trimStart();
  const bar = text.indexOf('|');
  const name = commandName(text);
  if (bar < 0) return KNOWN.has(name) ? text.trim() : text.trim().slice(0, NAME_SHOWN_MAX);
  const written = text.slice(0, bar).trim();
  if (Object.hasOwn(BEFORE_SECRET, name)) {
    const fields = text.slice(bar + 1).split('|');
    const before = BEFORE_SECRET[name];
    const whole = fields.length > before &&
      (name !== 'WIFI_SEC' || SECURITY_FIELD.choices.includes(fields[1].trim().toUpperCase()));
    return [written, ...(whole ? fields.slice(0, before) : []), MASK].join('|');
  }
  return KNOWN.has(name) ? text : `${written.slice(0, NAME_SHOWN_MAX)}|${MASK}`;
}

/**
 * Check what a form holds against the firmware's rules, and build its line. Nothing is
 * sent unless `errors` is empty. A value that is left out is left off the line: STATUS|
 * is a request for a section with an empty name, not for all of them.
 */
export function checkCommand(command, values) {
  const errors = {};
  const parts = [command.name];
  for (const field of command.fields) {
    const value = values[field.key] ?? '';
    if (field.choices) {
      if (!field.choices.includes(value)) errors[field.key] = `${field.label} must be one of the choices`;
    } else if (field.rule) {
      const wrong = RULES[field.rule](value);
      if (wrong) errors[field.key] = wrong;
    }
    if (value !== '' || !field.optional) parts.push(value);
  }
  if (command.confirm && values.confirm !== command.confirm) errors.confirm = `Type ${command.confirm} to confirm`;
  const line = parts.join('|');
  if (Object.keys(errors).length === 0 && byteLength(line) > LINE_MAX) {
    errors[command.fields[0]?.key ?? 'confirm'] = `line too long, the limit is ${LINE_MAX} bytes`;
  }
  return { errors, line };
}

/**
 * What to do with a line from the free input: `refused` says why it is not sent. Echo
 * stays off, so that nothing typed here comes back. What erases the board goes through
 * its form, where it has to be confirmed.
 */
export function checkTyped(typed) {
  const line = typed.trimStart();
  if (line.trim() === '') return { line: '' };
  if (byteLength(line) > LINE_MAX) return { refused: `line too long, the limit is ${LINE_MAX} bytes` };
  if (CONTROL.test(line)) return { refused: 'a line cannot hold a control character' };
  const name = commandName(line);
  const command = KNOWN.get(name);
  if (command?.confirm) {
    return { refused: `${command.name} erases the board, so it asks for a typed confirmation: use its form on this page.` };
  }
  if (name === 'ECHO' && /\|\s*on\s*$/i.test(line)) {
    return { refused: 'Echo stays off on this page, so that the board does not send back what is typed. A plain serial monitor can turn it on.' };
  }
  return { line, keep: Boolean(command) && !Object.hasOwn(BEFORE_SECRET, name) };
}

// Reading: bytes in, whole lines out.

/**
 * Turns reads of any size into lines. CR, LF and CRLF each end one line, also when the
 * CRLF or a character is split over two reads. A line that never ends is cut off at a
 * limit, so that this cannot grow without bound.
 */
export function createLineReader() {
  const decoder = new TextDecoder();
  let partial = '';
  let afterCr = false;
  return {
    feed(bytes) {
      const lines = [];
      for (const character of decoder.decode(bytes, { stream: true })) {
        const lfOfCrlf = afterCr && character === '\n';
        afterCr = character === '\r';
        if (lfOfCrlf) continue;
        if (character === '\r' || character === '\n') {
          lines.push(partial);
          partial = '';
        } else {
          partial += character;
          if (partial.length >= PARTIAL_MAX) {
            lines.push(partial);
            partial = '';
          }
        }
      }
      return lines;
    },
    /** What is left when the connection ends: a line that was never finished, if any. */
    flush() {
      const rest = partial;
      partial = '';
      afterCr = false;
      return rest === '' ? null : rest;
    },
  };
}

const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const TAG_LINE = /^\[([^\]\s]{1,32})\] ?(.*)$/s;
const FINAL_LINE = /^(OK|ERR)(?: (.*))?$/s;
const LEVEL = /^(ERR|WRN): (.*)$/s;

/** What kind of line the board sent, or null for an empty one. */
export function classifyLine(raw) {
  const text = raw.replace(ESCAPES, '').replace(UNPRINTABLE, '');
  if (text.trim() === '') return null;
  const tagged = TAG_LINE.exec(text);
  if (tagged) {
    const level = LEVEL.exec(tagged[2]);
    return { kind: 'tag', tag: tagged[1], level: level?.[1] ?? null, text: level ? level[2] : tagged[2] };
  }
  const final = FINAL_LINE.exec(text);
  if (final) return { kind: final[1] === 'OK' ? 'ok' : 'err', text: final[2] ?? '' };
  return { kind: 'output', text };
}

// A command coming back. HELP's lines hold the same words, but they start with a mark.
const ECHOED_SECRET = /^(?:> ?)?(wifi(?:_sec)?\|.*)$/is;

/** A line of output as it may be shown: a Wi-Fi command coming back is masked like one going out. */
function shownOutput(text) {
  const echoed = ECHOED_SECRET.exec(text);
  return echoed ? shownCommand(echoed[1]) : text;
}

// Plain words for what can go wrong.

const OTHER_PORT = 'No answer in 2 seconds, so this looks like the other port. The DK has two ' +
  'virtual COM ports and only one carries the console: disconnect and choose the other one.';
const UNPLUGGED = 'The connection to the board ended. The USB cable may have come out, or the board lost power.';
const NOT_CHOSEN = 'No port was chosen. If the list was empty, check that the DK is switched on and that ' +
  'its J-Link USB port is connected.';

function chooseProblem(error) {
  if (error?.name === 'NotFoundError') return NOT_CHOSEN;
  if (error?.name === 'SecurityError') return 'The browser did not allow this page to use a serial port.';
  return 'The list of serial ports could not be opened. Reload the page and try again.';
}

function openProblem(error) {
  if (error?.name === 'InvalidStateError') {
    return 'This port is already open, perhaps in another tab of this console. Close it there and try again.';
  }
  return 'The port could not be opened. Another program, such as a serial monitor, probably has it: ' +
    'close that program and try again.';
}

function clockNow(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// The connection.

/**
 * One connection to one board, and everything the page shows about it. Its fields are
 * read by the view; `onChange` says when to draw again.
 *
 * phase: idle, opening, probing (asking who is there), silent (nobody answered), ready
 * or closing. Commands can only be sent when it is ready.
 */
export function createSerialSession({ serial, onChange = () => {}, now = () => new Date() }) {
  let port = null;
  let writer = null;
  let reader = null;
  let reading = null;
  let closing = false;
  let settling = null;
  let restartTimer = 0;
  let nextId = 1;
  let lineReader = createLineReader();
  // What was sent and has no final line yet, oldest first. It holds the masked form only.
  const waiting = [];

  const session = {
    phase: 'idle',
    problem: null,
    board: null,
    lines: [],
    linesDropped: 0,
    said: '',
    saidCount: 0,
    typed: [],
    reply: null,
    pinned: true,
    unseen: 0,
    connect,
    disconnect,
    send,
    probe,
    clear,
    remember,
    setPinned,
  };

  function changed() {
    onChange();
  }

  function setPhase(phase) {
    session.phase = phase;
    changed();
  }

  function add(line) {
    session.lines.push({ ...line, id: nextId, at: clockNow(now()) });
    nextId += 1;
    if (session.lines.length > LINES_KEPT) {
      session.linesDropped += session.lines.length - LINES_KEPT;
      session.lines.splice(0, session.lines.length - LINES_KEPT);
    }
    if (!session.pinned) session.unseen += 1;
    changed();
  }

  function note(text, tone = 'idle') {
    add({ kind: 'note', tone, text });
  }

  function clear() {
    session.lines.length = 0;
    session.linesDropped = 0;
    session.unseen = 0;
    session.pinned = true;
    changed();
  }

  function setPinned(pinned) {
    if (session.pinned === pinned) return;
    session.pinned = pinned;
    if (pinned) session.unseen = 0;
    changed();
  }

  /** Keep a command for the arrow keys, unless it is the one before it. */
  function remember(line) {
    if (session.typed.at(-1) !== line) session.typed.push(line);
    if (session.typed.length > COMMANDS_KEPT) session.typed.shift();
  }

  // Writing.

  async function write(line) {
    const bytes = encoder.encode(`${line}\r\n`);
    try {
      await writer.write(bytes);
    } finally {
      // The string cannot be wiped. Its bytes can.
      bytes.fill(0);
    }
  }

  /** Send a line and wait for its final line. Resolves to that line, or to null if none comes. */
  function exec(line, { wait = REPLY_MS, auto = false, form = null } = {}) {
    if (!writer) return Promise.resolve(null);
    const shown = shownCommand(line);
    const name = commandName(line);
    add({ kind: 'sent', text: shown, auto });
    if (form) session.reply = { form, kind: 'wait', text: 'Sent, waiting for the board.' };
    return new Promise((resolve) => {
      const entry = { shown, name, form, resolve, echoed: false, timer: 0 };
      entry.timer = setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        if (!auto) note(`No reply to ${name} after ${wait / 1000} seconds.`, 'warn');
        if (form && session.reply?.form === form) session.reply = { form, kind: 'none', text: 'No reply from the board.' };
        resolve(null);
        changed();
      }, wait);
      waiting.push(entry);
      write(line).catch(() => {
        if (port) lost('Writing to the port failed. The board may have been disconnected.');
      });
    });
  }

  /**
   * Send a line from the page. Before a line with a password the board is told again not
   * to echo, because a restart turns its echo back on, and the line stays here if the
   * board does not confirm that. Resolves to { sent, problem }.
   */
  async function send(line, { form = null } = {}) {
    if (session.phase !== 'ready') return { sent: false, problem: 'Connect to a board first.' };
    if (holdsSecret(line)) {
      const quiet = await exec('ECHO|OFF', { wait: PROBE_MS, auto: true });
      if (quiet?.kind !== 'ok' || !writer) {
        return {
          sent: false,
          problem: 'The board did not confirm that its echo is off, so the password was not sent. Type it again.',
        };
      }
    }
    exec(line, { form });
    return { sent: true };
  }

  // Reading.

  function finalLine(line) {
    const entry = waiting.shift();
    if (entry) {
      clearTimeout(entry.timer);
      if (entry.form) session.reply = { form: entry.form, kind: line.kind, text: line.text };
      if (entry.name === 'GET_ID' && line.kind === 'ok') {
        const bar = line.text.lastIndexOf('|');
        session.board = bar < 0 ? { id: line.text, version: '' }
          : { id: line.text.slice(0, bar), version: line.text.slice(bar + 1) };
      }
    }
    add(line);
    session.said = `${line.kind === 'ok' ? 'OK' : 'Error'}${line.text ? `: ${line.text}` : ''}`;
    session.saidCount += 1;
    entry?.resolve(line);
    // A reply after the wait was over: there is a console on this port after all.
    if (session.phase === 'silent') settle();
    changed();
  }

  /** A board that restarts has its echo on again, and may be another board by now. */
  function restarted() {
    if (restartTimer || !['ready', 'silent'].includes(session.phase)) return;
    restartTimer = setTimeout(() => {
      restartTimer = 0;
      if (session.phase === 'silent') {
        probe();
      } else if (session.phase === 'ready') {
        exec('ECHO|OFF', { wait: PROBE_MS, auto: true });
        exec('GET_ID', { wait: PROBE_MS, auto: true });
      }
    }, RESTART_SETTLE_MS);
  }

  function takeLine(raw) {
    const line = classifyLine(raw);
    if (!line) return;
    if (line.kind === 'ok' || line.kind === 'err') {
      finalLine(line);
      return;
    }
    if (line.kind === 'tag') {
      add(line);
      if (line.tag === 'BOOT') restarted();
      return;
    }
    // What was just sent coming back is not news. It is compared in its masked form.
    const asCommand = shownCommand(line.text);
    const echo = waiting.find((entry) => !entry.echoed && entry.shown === asCommand);
    if (echo) {
      echo.echoed = true;
      return;
    }
    add({ kind: 'output', text: shownOutput(line.text) });
  }

  async function readAll(current) {
    while (current.readable && !closing) {
      reader = current.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            if (!closing) lost(UNPLUGGED);
            return;
          }
          if (value) for (const raw of lineReader.feed(value)) takeLine(raw);
        }
      } catch (error) {
        if (closing) return;
        // These leave the port open, and the browser gives it a new stream.
        if (current.readable && error?.name !== 'NetworkError') note('Some of what the board sent was lost on the way.', 'warn');
        else lost(UNPLUGGED);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // A reader that is gone already holds nothing.
        }
        reader = null;
      }
    }
  }

  // Connecting and disconnecting.

  async function settle() {
    if (settling) return settling;
    settling = (async () => {
      await exec('ECHO|OFF', { wait: PROBE_MS, auto: true });
      if (port) {
        session.problem = null;
        setPhase('ready');
      }
    })();
    try {
      await settling;
    } finally {
      settling = null;
    }
    return undefined;
  }

  /** Ask who is on the port. Nothing else is sent until something answers. */
  async function probe() {
    if (!port) return;
    session.problem = null;
    setPhase('probing');
    const answer = await exec('GET_ID', { wait: PROBE_MS, auto: true });
    if (!port) return;
    if (answer) {
      await settle();
    } else {
      session.problem = OTHER_PORT;
      setPhase('silent');
    }
  }

  async function connect() {
    if (session.phase !== 'idle') return;
    session.problem = null;
    session.board = null;
    setPhase('opening');
    let chosen;
    try {
      chosen = await serial.requestPort({ filters: [{ usbVendorId: SEGGER_VENDOR_ID }] });
    } catch (error) {
      session.problem = chooseProblem(error);
      setPhase('idle');
      return;
    }
    try {
      await chosen.open({ baudRate: BAUD_RATE });
    } catch (error) {
      session.problem = openProblem(error);
      setPhase('idle');
      return;
    }
    port = chosen;
    closing = false;
    lineReader = createLineReader();
    writer = port.writable.getWriter();
    reading = readAll(port);
    note(`Port open at ${BAUD_RATE} baud.`);
    await probe();
  }

  async function shutDown(problem) {
    if (!port) return;
    const current = port;
    port = null;
    closing = true;
    clearTimeout(restartTimer);
    restartTimer = 0;
    session.phase = 'closing';
    session.problem = problem;
    session.board = null;
    if (session.reply?.kind === 'wait') session.reply = null;
    const rest = lineReader.flush();
    if (rest !== null) takeLine(rest);
    for (const entry of waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    const held = writer;
    writer = null;
    changed();
    try {
      await reader?.cancel();
    } catch {
      // The port may be gone: there is nothing left to cancel.
    }
    await reading?.catch(() => {});
    // Not close(): that waits for what is queued, which a stuck port never takes.
    try {
      await held.abort();
    } catch {
      // The same.
    }
    try {
      held.releaseLock();
      await current.close();
    } catch {
      // The same.
    }
    reading = null;
    closing = false;
    setPhase('idle');
  }

  function lost(problem) {
    if (!port) return;
    note(problem, 'bad');
    shutDown(problem);
  }

  async function disconnect() {
    if (!port) return;
    note('Disconnected.');
    await shutDown(null);
  }

  serial.addEventListener?.('disconnect', (event) => {
    if (port && event.target === port) lost(UNPLUGGED);
  });

  return session;
}

// The page.

// What the page remembers about its own controls while it is open. Nothing typed is here,
// and no reference to a field that would outlive it: a field's value stays in the field,
// which goes when the reader leaves the page, until it is read to send it.
const ui = {
  errors: new Map(),
  problems: new Map(),
  typedProblem: null,
  typedHidden: false,
  recalling: -1,
};

let shared = null;

function sharedSession(ctx) {
  shared ??= createSerialSession({ serial: navigator.serial, onChange: ctx.actions.redraw });
  return shared;
}

const TRANSCRIPT_ID = 'serial-transcript';
// Within this of the end counts as reading the end.
const PINNED_WITHIN = 32;

/** After drawing: follow the newest line, unless the reader has scrolled up. */
export function keepTranscriptInView() {
  if (!shared?.pinned) return;
  const el = document.getElementById(TRANSCRIPT_ID);
  if (el) el.scrollTop = el.scrollHeight;
}

const MARKS = {
  ok: ['check-circle', 'OK'],
  err: ['x-circle', 'ERR'],
};
const LEVELS = { ERR: ['bad', 'x-circle'], WRN: ['warn', 'alert'] };
const NOTE_ICONS = { idle: 'minus', warn: 'alert', bad: 'x-circle' };

function lineText(text) {
  // A line of a box keeps its columns.
  const boxed = /^[+|]/.test(text);
  return h('span', { class: `serial-text ${boxed ? 'is-box' : ''}`.trim() }, text);
}

function finalWord(kind) {
  const [iconName, word] = MARKS[kind];
  return h('span', { class: 'serial-word' }, icon(iconName, 'is-small'), word);
}

// The spaces are for whoever copies a line or hears it read: on the page the gaps do the work.
function transcriptLine(line) {
  const parts = {
    sent: () => [
      h('span', { class: 'serial-chevron', 'aria-hidden': 'true' }, '>'),
      h('span', { class: 'sr-only' }, 'Sent: '),
      lineText(line.text),
      line.auto ? [' ', h('span', { class: 'serial-auto' }, 'sent by the page')] : null,
    ],
    ok: () => [finalWord('ok'), ' ', lineText(line.text)],
    err: () => [finalWord('err'), ' ', lineText(line.text)],
    tag: () => [
      h('span', { class: 'serial-tag' }, `[${line.tag}]`),
      ' ',
      line.level
        ? [h('span', { class: `serial-level is-${LEVELS[line.level][0]}` }, icon(LEVELS[line.level][1], 'is-small'), line.level), ' ']
        : null,
      lineText(line.text),
    ],
    output: () => [lineText(line.text)],
    note: () => [icon(NOTE_ICONS[line.tone], 'is-small'), h('span', { class: 'serial-text' }, line.text)],
  };
  return h('li', {
    key: line.id,
    class: `serial-line is-${line.kind} ${line.kind === 'note' ? `is-tone-${line.tone}` : ''}`.trim(),
  }, parts[line.kind](), ' ', h('time', { class: 'serial-time' }, line.at));
}

function transcript(session) {
  return [
    h('div', {
      id: TRANSCRIPT_ID,
      class: 'serial-transcript',
      key: 'transcript',
      tabindex: '0',
      role: 'group',
      'aria-label': 'Transcript of what was sent and what the board said',
      onScroll: (event) => {
        const el = event.currentTarget;
        session.setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_WITHIN);
      },
    },
    session.lines.length === 0
      ? h('p', { class: 'serial-blank' }, 'What is sent and what the board says will appear here.')
      : h('ol', { class: 'serial-lines' },
        session.linesDropped > 0
          ? h('li', { key: 'dropped', class: 'serial-line is-note is-tone-idle' },
            h('span', { class: 'serial-text' }, `${session.linesDropped} earlier lines are no longer kept.`))
          : null,
        session.lines.map(transcriptLine))),
    !session.pinned && session.unseen > 0
      ? button('is-small serial-latest', () => {
        session.setPinned(true);
        keepTranscriptInView();
      }, icon('download'), `${session.unseen} new, go to the latest`)
      : null,
    // Only the final line of a reply is read out. The sentence is the same when a reply
    // repeats, and a live region stays quiet then, so the two forms differ by a space.
    h('p', { class: 'sr-only', key: 'said', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
      session.said ? `${session.said}${session.saidCount % 2 ? '' : ' '}` : ''),
  ];
}

const PHASES = {
  idle: ['status is-quiet', 'minus-circle', 'Not connected'],
  opening: ['status is-live', 'hourglass', 'Choosing a port…'],
  probing: ['status is-live', 'hourglass', 'Asking the board who it is…'],
  silent: ['status is-warn', 'alert', 'No answer on this port'],
  ready: ['status is-good', 'check-circle', 'Connected'],
  closing: ['status is-quiet', 'hourglass', 'Disconnecting…'],
};

function connectionState(session) {
  const [className, iconName, words] = PHASES[session.phase];
  const { board } = session;
  return h('div', { class: 'serial-state', key: 'state' },
    h('p', { class: className, role: 'status' }, icon(iconName), words),
    session.phase === 'ready' && board
      ? h('p', { class: 'serial-board' },
        board.id ? mono(board.id) : 'No ID yet',
        board.version ? [' · firmware ', mono(board.version)] : null)
      : null);
}

function connectionTools(session) {
  const open = !['idle', 'opening'].includes(session.phase);
  return h('div', { class: 'serial-tools', key: 'tools' },
    open
      ? [
        session.phase === 'silent'
          ? h('button', { type: 'button', key: 'again', class: 'btn is-small', onClick: session.probe }, icon('restart'), 'Ask again')
          : null,
        h('button', {
          type: 'button', key: 'off', class: 'btn is-small', disabled: session.phase === 'closing', onClick: session.disconnect,
        }, 'Disconnect'),
      ]
      : h('button', {
        type: 'button', key: 'on', class: 'btn is-small is-primary', disabled: session.phase === 'opening', onClick: session.connect,
      }, 'Connect a board'),
    h('button', {
      type: 'button', key: 'clear', class: 'btn is-small is-quiet', disabled: session.lines.length === 0, onClick: session.clear,
    }, 'Clear'));
}

const fieldById = (id) => document.getElementById(id);

function typedInput(session, ctx) {
  const ready = session.phase === 'ready';
  const field = () => fieldById('serial-typed');
  // Back on the page the field is a new, empty one.
  if (!field()) ui.typedHidden = false;
  const set = (value) => {
    const el = field();
    if (el) el.value = value;
  };
  const noteHidden = (hidden) => {
    if (ui.typedHidden !== hidden) {
      ui.typedHidden = hidden;
      ctx.actions.redraw();
    }
  };
  const submit = (event) => {
    event.preventDefault();
    const el = field();
    if (!el) return;
    const result = checkTyped(el.value);
    ui.typedProblem = result.refused ?? null;
    if (result.line) {
      // Out of the field before anything else can happen to it.
      el.value = '';
      ui.typedHidden = false;
      ui.recalling = -1;
      if (result.keep) session.remember(result.line.trimEnd());
      session.send(result.line).then(({ sent, problem }) => {
        if (!sent) {
          ui.typedProblem = problem;
          ctx.actions.redraw();
        }
      });
    }
    ctx.actions.redraw();
  };
  const recall = (event) => {
    const { typed } = session;
    if (event.key === 'ArrowUp' && ui.recalling < typed.length - 1) ui.recalling += 1;
    else if (event.key === 'ArrowDown' && ui.recalling >= 0) ui.recalling -= 1;
    else return;
    event.preventDefault();
    set(ui.recalling < 0 ? '' : typed[typed.length - 1 - ui.recalling]);
    noteHidden(false);
  };
  return h('form', { class: 'serial-prompt', key: 'prompt', autocomplete: 'off', onSubmit: submit },
    h('label', { class: 'field-label', for: 'serial-typed' }, 'Command'),
    h('div', { class: 'serial-prompt-row' },
      h('input', {
        id: 'serial-typed',
        class: 'input mono',
        // A line with a password is hidden while it is being typed.
        type: ui.typedHidden ? 'password' : 'text',
        autocomplete: ui.typedHidden ? 'new-password' : 'off',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: 'false',
        placeholder: 'COMMAND|arg1|arg2',
        disabled: !ready,
        'aria-describedby': 'serial-typed-hint',
        onInput: (event) => noteHidden(holdsSecret(event.currentTarget.value)),
        onKeydown: recall,
      }),
      h('button', { type: 'submit', class: 'btn', disabled: !ready }, icon('send'), 'Send')),
    h('p', { class: 'field-hint', id: 'serial-typed-hint' },
      ui.typedHidden
        ? 'This line holds a password, so it stays hidden and will not be kept.'
        : 'The up and down arrows bring back earlier commands. Wi-Fi commands are never kept.'),
    ui.typedProblem
      ? h('p', { class: 'serial-error', role: 'alert' }, icon('alert', 'is-small'), ui.typedProblem)
      : null);
}

function fieldError(command, key) {
  const error = ui.errors.get(command.name)?.[key];
  return error
    ? h('p', { class: 'serial-error', id: `serial-${command.name}-${key}-error`, role: 'alert' }, icon('alert', 'is-small'), error)
    : null;
}

function describedBy(command, key, hint) {
  const ids = [];
  if (hint) ids.push(`serial-${command.name}-${key}-hint`);
  if (ui.errors.get(command.name)?.[key]) ids.push(`serial-${command.name}-${key}-error`);
  return ids.join(' ') || null;
}

const SECTION_WORDS = { '': 'All of them' };

function formField(command, field) {
  const id = `serial-${command.name}-${field.key}`;
  const common = {
    id,
    key: field.key,
    class: `input ${field.secret ? '' : 'mono'}`.trim(),
    'aria-describedby': describedBy(command, field.key, field.hint),
    'aria-invalid': ui.errors.get(command.name)?.[field.key] ? 'true' : null,
  };
  return h('div', { class: 'field', key: field.key },
    h('label', { class: 'field-label', for: id }, field.label),
    field.choices
      ? h('select', common, field.choices.map((choice) =>
        h('option', { key: choice, value: choice }, SECTION_WORDS[choice] ?? choice)))
      : h('input', {
        ...common,
        type: field.secret ? 'password' : 'text',
        // Not the browser's to fill in, and not its to remember.
        autocomplete: field.secret ? 'new-password' : 'off',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
    field.hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, field.hint) : null,
    fieldError(command, field.key));
}

function confirmField(command) {
  const id = `serial-${command.name}-confirm`;
  return h('div', { class: 'field', key: 'confirm' },
    h('label', { class: 'field-label', for: id }, 'Type ', mono(command.confirm), ' to confirm'),
    h('input', {
      id,
      class: 'input mono',
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-describedby': describedBy(command, 'confirm', false),
      'aria-invalid': ui.errors.get(command.name)?.confirm ? 'true' : null,
    }),
    fieldError(command, 'confirm'));
}

const REPLY_MARKS = {
  ok: ['check-circle', 'OK'],
  err: ['x-circle', 'ERR'],
  wait: ['hourglass', ''],
  none: ['alert', ''],
};

function replyOf(command, session) {
  const problem = ui.problems.get(command.name);
  if (problem) return h('p', { class: 'serial-error', role: 'alert' }, icon('alert', 'is-small'), problem);
  const { reply } = session;
  if (reply?.form !== command.name) return null;
  const [iconName, word] = REPLY_MARKS[reply.kind];
  return h('p', { class: `serial-result is-${reply.kind}` }, icon(iconName, 'is-small'), word ? `${word} ` : '', reply.text);
}

/** Read a form's fields, check them, and send: out of the field first if it is a password. */
function submitForm(command, session, ctx) {
  const inputs = command.fields.map((field) => [field, fieldById(`serial-${command.name}-${field.key}`)]);
  const confirmEl = command.confirm ? fieldById(`serial-${command.name}-confirm`) : null;
  const values = Object.fromEntries(inputs.map(([field, el]) => [field.key, el?.value ?? '']));
  if (confirmEl) values.confirm = confirmEl.value;
  const { errors, line } = checkCommand(command, values);
  ui.problems.delete(command.name);
  if (Object.keys(errors).length > 0) {
    ui.errors.set(command.name, errors);
    ctx.actions.redraw();
    const first = command.fields.find((field) => errors[field.key]);
    (first ? fieldById(`serial-${command.name}-${first.key}`) : confirmEl)?.focus();
    return;
  }
  ui.errors.delete(command.name);
  for (const [field, el] of inputs) if (field.secret && el) el.value = '';
  if (confirmEl) confirmEl.value = '';
  session.send(line, { form: command.name }).then(({ sent, problem }) => {
    if (!sent) {
      ui.problems.set(command.name, problem);
      ctx.actions.redraw();
    }
  });
  ctx.actions.redraw();
}

function commandRow(command, session, ctx) {
  const action = command.confirm ? 'is-danger' : '';
  const send = (event) => {
    event?.preventDefault();
    submitForm(command, session, ctx);
  };
  const reply = replyOf(command, session);
  if (command.fields.length === 0 && !command.confirm) {
    return h('div', { class: 'serial-row is-plain', key: command.name },
      h('button', { type: 'button', class: 'btn is-small mono', onClick: send }, command.name),
      h('p', { class: 'serial-does' }, command.text),
      reply);
  }
  return h('form', { class: 'serial-row', key: command.name, autocomplete: 'off', noValidate: true, onSubmit: send },
    h('h3', { class: 'serial-name mono' }, command.name),
    h('p', { class: 'serial-does' }, command.text),
    command.fields.map((field) => formField(command, field)),
    command.confirm ? confirmField(command) : null,
    h('div', { class: 'serial-row-foot' },
      h('button', { type: 'submit', class: `btn is-small ${action} mono`.trim() }, command.name)),
    reply);
}

function commandForms(session, ctx) {
  const ready = session.phase === 'ready';
  return h('div', { class: 'serial-forms', key: 'forms' },
    h('fieldset', { class: 'serial-fieldset', disabled: !ready },
      h('legend', { class: 'sr-only' }, 'Commands'),
      ready ? null : h('p', { class: 'serial-waiting' }, icon('lock', 'is-small'), 'Connect a board to use these.'),
      GROUPS.map(([group, title]) => h('section', { class: 'serial-group', key: group },
        h('h2', { class: 'eyebrow' }, title),
        COMMANDS.filter((command) => command.group === group).map((command) => commandRow(command, session, ctx))))));
}

const LEDE = 'Drive a board on its USB cable from this browser. What you type here goes only over the ' +
  'cable to the board, never to the server, and nothing is saved.';

function explained(title, text, command) {
  return h('div', { class: 'page', key: 'page' },
    developerTabs('serial'),
    pageHead({ title: 'Serial console', lede: 'Drive a board on its USB cable from this browser.' }),
    h('section', { class: 'card', key: 'why' }, empty({ iconName: 'lock', title, text, command })));
}

/** The page. `session` is given by the tests; otherwise the tab has one connection. */
export function serialView(ctx, session) {
  if (!ctx.state.me?.canWrite) {
    return explained('The serial console is for release managers.',
      'It drives a board directly and can erase it, so a viewer does not get its controls. ' +
      'Ask a release manager to do what you need, or to add you to their group.');
  }
  if (!session && !navigator.serial) {
    return explained('This browser cannot reach a serial port.',
      'Web Serial exists only in Chrome and Edge, on a secure (https) address. Open this page there, ' +
      'or use a plain serial monitor at 115200 baud:',
      'screen /dev/cu.usbmodem<port> 115200');
  }
  const current = session ?? sharedSession(ctx);
  return h('div', { class: 'page serial-page', key: 'page' },
    developerTabs('serial'),
    pageHead({ title: 'Serial console', lede: LEDE }),
    h('div', { class: 'serial-layout', key: 'layout' },
      h('section', { class: 'panel on-ink serial-panel', key: 'panel', 'aria-label': 'Connection and transcript' },
        h('header', { class: 'serial-head', key: 'head' }, connectionState(current), connectionTools(current)),
        current.problem
          ? notice(current.phase === 'silent' || current.problem === NOT_CHOSEN ? 'warn' : 'bad', 'alert', current.problem)
          : null,
        transcript(current),
        typedInput(current, ctx)),
      commandForms(current, ctx)));
}
