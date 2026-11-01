/**
 * Tests for the serial console. serial.js is the very file the browser loads; the board
 * is a stand-in for a port as navigator.serial hands it out, with a small model of the
 * firmware's replies behind it. Nothing here touches a real port.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  SERIAL, VIEWS, all, click, createDocument, descendants, one, textOf,
} from './page.mjs';

const serial = await import(SERIAL);
const views = await import(VIEWS);
const {
  COMMANDS, MASK, checkCommand, checkTyped, classifyLine, createLineReader, createSerialSession, holdsSecret, shownCommand,
} = serial;

globalThis.document = createDocument();

const PASSWORD = 'correct-horse|battery-9';
const encoder = new TextEncoder();
const command = (name) => COMMANDS.find((item) => item.name === name);
const bytes = (text) => encoder.encode(text);

/** Let what is waiting on streams and promises run. The clock is the test's. */
async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await new Promise(setImmediate);
}

// The board.

const REPLIES = {
  GET_ID: () => 'OK ABC123|1.2.3+5\r\n',
  ECHO: (line) => `OK echo ${line.split('|')[1].toLowerCase()}\r\n`,
  WIFI: (line) => `OK saved, connecting to ${line.split('|')[1]}\r\n`,
  WIFI_SEC: (line) => `OK saved, connecting to ${line.split('|')[1]}\r\n`,
  NET: () => 'state connected\r\nssid Lab\r\nOK\r\n',
};

function fakeBoard({ reply = (line) => (REPLIES[line.split('|')[0].toUpperCase()]?.(line) ?? 'OK\r\n'), echo = false } = {}) {
  const decoder = new TextDecoder();
  let source = null;
  let incoming = '';
  const board = {
    lines: [],
    handed: [],
    echo,
    opened: null,
    closed: false,
    send: (text) => source.enqueue(bytes(text)),
    port: null,
  };
  board.port = {
    readable: new ReadableStream({ start(controller) { source = controller; } }),
    writable: new WritableStream({
      write(chunk) {
        // What a real port would have taken by now, and the array that was handed over.
        board.handed.push(chunk);
        incoming += decoder.decode(chunk);
        let end = incoming.indexOf('\r\n');
        while (end >= 0) {
          const line = incoming.slice(0, end);
          incoming = incoming.slice(end + 2);
          board.lines.push(line);
          const answer = reply(line);
          if (board.echo) source.enqueue(bytes(`${line}\r\n`));
          if (/^echo\|off$/i.test(line)) board.echo = false;
          if (answer) source.enqueue(bytes(answer));
          end = incoming.indexOf('\r\n');
        }
      },
    }),
    open: async (options) => { board.opened = options; },
    close: async () => { board.closed = true; },
  };
  return board;
}

function fakeSerial(board) {
  const listeners = new Set();
  return {
    asked: null,
    async requestPort(options) {
      this.asked = options;
      return board.port;
    },
    addEventListener: (type, listener) => listeners.add(listener),
    unplug: () => listeners.forEach((listener) => listener({ target: board.port })),
  };
}

/** A session on a board, connected unless told otherwise. */
async function connected(t, options = {}, { connect = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const board = fakeBoard(options);
  const port = fakeSerial(board);
  const session = createSerialSession({ serial: port });
  if (connect) {
    session.connect();
    await settle();
  }
  return { board, port, session };
}

const sentLines = (session) => session.lines.filter((line) => line.kind === 'sent').map((line) => line.text);
const kinds = (session) => session.lines.map((line) => line.kind);

// Drawing.

function drawn(session, me = { canWrite: true }) {
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  const ctx = {
    state: { me },
    actions: { redraw: () => views.render(box, serial.serialView(ctx, session)) },
  };
  ctx.actions.redraw();
  return { box, redraw: ctx.actions.redraw };
}

const field = (box, id) => descendants(box).find((el) => el.getAttribute('id') === id);

function everythingShown(box) {
  return descendants(box).flatMap((el) => [
    textOf(el), el.value, ...[...el.attributes.values()].map(String),
  ]).join('\n');
}

/** Storage that says when it is used, in place of the browser's. */
function watchStorage(t) {
  const writes = [];
  const store = {
    setItem: (...args) => writes.push(args),
    getItem: () => null,
    removeItem() {},
    clear() {},
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true });
    t.after(() => { delete globalThis[name]; });
  }
  return writes;
}

// Reading lines.

test('CR, LF and CRLF each end one line, and blank lines are not lines of the board', () => {
  const reader = createLineReader();
  assert.deepEqual(reader.feed(bytes('one\rtwo\nthree\r\nfour')), ['one', 'two', 'three']);
  assert.deepEqual(reader.feed(bytes('\r\n')), ['four']);
  assert.equal(classifyLine(''), null);
  assert.equal(classifyLine('   '), null);
});

test('a line split over two reads is one line, also when the split is inside the CRLF', () => {
  const reader = createLineReader();
  assert.deepEqual(reader.feed(bytes('OK sav')), []);
  assert.deepEqual(reader.feed(bytes('ed\r')), ['OK saved']);
  assert.deepEqual(reader.feed(bytes('\n[WIFI] conn')), []);
  assert.deepEqual(reader.feed(bytes('ected\r\n')), ['[WIFI] connected']);
  assert.equal(reader.flush(), null);
});

test('a character split over two reads is one character', () => {
  const reader = createLineReader();
  const coffee = bytes('Café\n');
  assert.deepEqual(reader.feed(coffee.slice(0, 4)), []);
  assert.deepEqual(reader.feed(coffee.slice(4)), ['Café']);
});

test('a line that never ends is cut off at a limit', () => {
  const reader = createLineReader();
  const lines = reader.feed(bytes('x'.repeat(10000)));
  assert.equal(lines.every((line) => line.length <= 4096), true);
  assert.equal(lines.length, 2);
});

test('replies, logs and events are told apart', () => {
  assert.deepEqual(classifyLine('OK ABC123|1.0.0'), { kind: 'ok', text: 'ABC123|1.0.0' });
  assert.deepEqual(classifyLine('OK'), { kind: 'ok', text: '' });
  assert.deepEqual(classifyLine('ERR id must be 1-32 letters or digits'),
    { kind: 'err', text: 'id must be 1-32 letters or digits' });
  assert.deepEqual(classifyLine('[WIFI] connected ip=192.168.1.42 rssi=-51'),
    { kind: 'tag', tag: 'WIFI', level: null, text: 'connected ip=192.168.1.42 rssi=-51' });
  assert.deepEqual(classifyLine('[ota] WRN: weak'), { kind: 'tag', tag: 'ota', level: 'WRN', text: 'weak' });
  assert.deepEqual(classifyLine('[ota] ERR: failed'), { kind: 'tag', tag: 'ota', level: 'ERR', text: 'failed' });
  // Not a final line, whatever it starts with.
  assert.equal(classifyLine('OKAY then').kind, 'output');
  assert.equal(classifyLine('ERROR 5').kind, 'output');
  assert.equal(classifyLine('  OK in a list').kind, 'output');
  assert.equal(classifyLine('| State OPERATING |').kind, 'output');
  // What a terminal would have acted on is dropped.
  assert.deepEqual(classifyLine('\u001b[31mOK\u001b[0m done'), { kind: 'ok', text: 'done' });
});

test('final lines and tagged lines that arrive in pieces and between each other stay apart', async (t) => {
  const { board, session } = await connected(t);
  const before = session.lines.length;
  session.send('NET');
  await settle();
  session.lines.length = before;
  board.send('[ota] Im');
  await settle();
  assert.equal(session.lines.length, before, 'half a line is not shown yet');
  board.send('age verified\r');
  board.send('\nssid La');
  await settle();
  board.send('b\r\n[net] WRN: weak\r\nOK don');
  await settle();
  board.send('e\r\n');
  await settle();
  assert.deepEqual(session.lines.slice(before).map((line) => [line.kind, line.text]), [
    ['tag', 'Image verified'], ['output', 'ssid Lab'], ['tag', 'weak'], ['ok', 'done'],
  ]);
  assert.equal(session.said, 'OK: done');
});

// Connecting.

test('it asks for a SEGGER port at 115200, asks who is there, and then turns the echo off', async (t) => {
  const { board, port, session } = await connected(t);
  assert.deepEqual(port.asked, { filters: [{ usbVendorId: 0x1366 }] });
  assert.deepEqual(board.opened, { baudRate: 115200 });
  assert.deepEqual(board.lines, ['GET_ID', 'ECHO|OFF']);
  assert.equal(session.phase, 'ready');
  assert.deepEqual(session.board, { id: 'ABC123', version: '1.2.3+5' });
  assert.equal(session.problem, null);
});

test('what was sent is not shown twice when the board echoes it', async (t) => {
  const { session } = await connected(t, { echo: true });
  assert.deepEqual(sentLines(session), ['GET_ID', 'ECHO|OFF']);
  assert.equal(kinds(session).includes('output'), false);
});

test('with no reply within 2 s it says that this looks like the other port', async (t) => {
  const { board, session } = await connected(t, { reply: () => '' });
  assert.equal(session.phase, 'probing');
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(session.phase, 'probing');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(session.phase, 'silent');
  assert.match(session.problem, /looks like the other port/);
  assert.deepEqual(board.lines, ['GET_ID'], 'nothing more is sent to a port that may have no console');
  assert.deepEqual((await session.send('NET')).sent, false);
});

test('an ERR is an answer too: the console is on this port', async (t) => {
  const { session } = await connected(t, { reply: (line) => (line === 'GET_ID' ? 'ERR busy\r\n' : 'OK\r\n') });
  assert.equal(session.phase, 'ready');
});

test('a console that answers late takes the page out of "the other port"', async (t) => {
  const { board, session } = await connected(t, { reply: (line) => (line === 'ECHO|OFF' ? 'OK echo off\r\n' : '') });
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(session.phase, 'silent');
  board.send('OK ABC123|1.2.3+5\r\n');
  await settle();
  assert.equal(session.phase, 'ready');
  assert.equal(session.problem, null);
  assert.equal(board.lines.at(-1), 'ECHO|OFF');
});

test('a board that restarts is told again not to echo, and is asked who it is', async (t) => {
  const { board, session } = await connected(t);
  board.lines.length = 0;
  board.echo = true;
  for (let line = 0; line < 8; line += 1) board.send('[BOOT] | State OPERATING |\r\n');
  await settle();
  t.mock.timers.tick(300);
  await settle();
  assert.deepEqual(board.lines, ['ECHO|OFF', 'GET_ID']);
  assert.equal(board.echo, false);
});

test('choosing no port, and a port another program holds, are said in plain words', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refuses = (name) => ({
    requestPort: async () => { throw Object.assign(new Error('x'), { name }); },
  });
  const cancelled = createSerialSession({ serial: refuses('NotFoundError') });
  await cancelled.connect();
  assert.equal(cancelled.phase, 'idle');
  assert.match(cancelled.problem, /No port was chosen/);

  const held = createSerialSession({
    serial: {
      requestPort: async () => ({ open: async () => { throw Object.assign(new Error('x'), { name: 'NetworkError' }); } }),
    },
  });
  await held.connect();
  assert.equal(held.phase, 'idle');
  assert.match(held.problem, /Another program/);
});

test('an unplugged board ends the connection, in plain words, and it can be connected again', async (t) => {
  const { board, port, session } = await connected(t);
  port.unplug();
  await settle();
  assert.equal(session.phase, 'idle');
  assert.match(session.problem, /USB cable/);
  assert.equal(board.closed, true);
  assert.equal(session.board, null);
  assert.deepEqual((await session.send('NET')).sent, false);
});

test('a read error that leaves the port open is reported and reading goes on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const board = fakeBoard();
  let fail = true;
  const streams = board.port.readable;
  const readable = {
    getReader() {
      if (!fail) return streams.getReader();
      fail = false;
      return {
        read: async () => { throw Object.assign(new Error('x'), { name: 'FramingError' }); },
        releaseLock() {},
      };
    },
  };
  board.port.readable = readable;
  const session = createSerialSession({ serial: fakeSerial(board) });
  session.connect();
  await settle();
  assert.equal(session.phase, 'ready');
  assert.equal(session.lines.some((line) => /was lost on the way/.test(line.text)), true);
});

test('disconnecting closes the port, and what never ended is shown once, masked', async (t) => {
  const { board, session } = await connected(t);
  board.send(`WIFI|Lab|${PASSWORD}`);
  await settle();
  await session.disconnect();
  await settle();
  assert.equal(session.phase, 'idle');
  assert.equal(board.closed, true);
  assert.equal(JSON.stringify(session.lines).includes(PASSWORD), false);
  assert.equal(session.lines.some((line) => line.text === `WIFI|Lab|${MASK}`), true);
});

test('no reply to a command is said, and later replies still count', async (t) => {
  const { board, session } = await connected(t, {
    reply: (line) => (line === 'STATS' ? '' : REPLIES[line.split('|')[0]]?.(line) ?? 'OK\r\n'),
  });
  session.send('STATS');
  await settle();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(session.lines.at(-1).kind, 'note');
  assert.match(session.lines.at(-1).text, /No reply to STATS/);
  board.send('OK late\r\n');
  await settle();
  assert.equal(session.lines.at(-1).kind, 'ok');
});

test('the transcript is bounded in memory, and says that it dropped lines', async (t) => {
  const { board, session } = await connected(t);
  board.send(Array.from({ length: 1500 }, (_, index) => `[log] line ${index}\r\n`).join(''));
  await settle();
  assert.equal(session.lines.length, 1000);
  assert.equal(session.lines.at(-1).text, 'line 1499');
  assert.equal(session.linesDropped > 500, true);
  const { box } = drawn(session);
  assert.match(textOf(box), /earlier lines are no longer kept/);
});

test('lines arriving while the reader has scrolled up are counted, and the view is left alone', async (t) => {
  const { board, session } = await connected(t);
  session.setPinned(false);
  board.send('[a] one\r\n[a] two\r\n');
  await settle();
  assert.equal(session.unseen, 2);
  const { box } = drawn(session);
  const transcript = field(box, 'serial-transcript');
  transcript.scrollHeight = 900;
  transcript.scrollTop = 100;
  serial.keepTranscriptInView();
  assert.equal(transcript.scrollTop, 100);
  assert.match(textOf(box), /2 new, go to the latest/);
  session.setPinned(true);
  assert.equal(session.unseen, 0);
});

// Rules: the firmware's, in its words.

const errorsOf = (name, values) => checkCommand(command(name), values).errors;

test('an ID is 1 to 32 letters or digits, as device_id_valid() has it', () => {
  const wrong = 'id must be 1-32 letters or digits';
  for (const id of ['A', 'abc123', 'A'.repeat(32)]) assert.deepEqual(errorsOf('SET_ID', { id }), {}, id);
  for (const id of ['', 'bad id!', 'A'.repeat(33), 'é', 'a-b', 'a|b', 'a\nFACTORY_RESET']) {
    assert.deepEqual(errorsOf('SET_ID', { id }), { id: wrong }, id);
  }
});

test('a network name is counted in bytes, cannot hold what the firmware would split on, and no line can be smuggled in', () => {
  const values = (ssid) => ({ ssid, password: 'long enough' });
  assert.deepEqual(errorsOf('WIFI', values('n'.repeat(32))), {});
  assert.equal(errorsOf('WIFI', values('')).ssid, 'ssid must be 1-32 bytes');
  assert.equal(errorsOf('WIFI', values('n'.repeat(33))).ssid, 'ssid must be 1-32 bytes');
  assert.equal(errorsOf('WIFI', values('é'.repeat(17))).ssid, 'ssid must be 1-32 bytes', '34 bytes in 17 characters');
  assert.match(errorsOf('WIFI', values('a|b')).ssid, /cannot contain \|/);
  assert.match(errorsOf('WIFI', values('a\r\nFACTORY_RESET')).ssid, /control character/);
});

test('a password is 8 to 63 bytes, empty means an open network, which is refused', () => {
  const values = (password) => ({ ssid: 'Lab', password });
  assert.deepEqual(errorsOf('WIFI', values('12345678')), {});
  assert.deepEqual(errorsOf('WIFI', values('p'.repeat(63))), {});
  assert.deepEqual(errorsOf('WIFI', values('with|bar!')), {}, 'the last argument may hold a |');
  assert.equal(errorsOf('WIFI', values('')).password, 'open networks are not allowed');
  assert.equal(errorsOf('WIFI', values('1234567')).password, 'password must be 8-63 characters');
  assert.equal(errorsOf('WIFI', values('p'.repeat(64))).password, 'password must be 8-63 characters');
  assert.equal(errorsOf('WIFI', values('é'.repeat(32))).password, 'password must be 8-63 characters', '64 bytes');
  assert.match(errorsOf('WIFI', values('12345678\nREBOOT')).password, /control character/);
});

test('what a rule says about a password never repeats it', () => {
  for (const password of ['short', 'p'.repeat(64), 'with\nline ending']) {
    assert.equal(JSON.stringify(errorsOf('WIFI', { ssid: 'Lab', password })).includes(password), false);
  }
});

test('the security mode is one of the three the firmware takes', () => {
  const values = (security) => ({ ssid: 'Lab', security, password: '12345678' });
  for (const security of ['WPA2_PSK', 'WPA2_PSK_SHA256', 'WPA3_SAE']) {
    assert.deepEqual(checkCommand(command('WIFI_SEC'), values(security)),
      { errors: {}, line: `WIFI_SEC|Lab|${security}|12345678` });
  }
  assert.equal('security' in errorsOf('WIFI_SEC', values('WEP')), true);
});

test('a section that is left out is left off the line', () => {
  assert.equal(checkCommand(command('STATUS'), { section: '' }).line, 'STATUS');
  assert.equal(checkCommand(command('STATUS'), { section: 'wifi' }).line, 'STATUS|wifi');
  assert.deepEqual(errorsOf('STATUS', { section: 'nonsense' }), { section: 'Section must be one of the choices' });
});

test('what erases the board needs its name typed exactly, and INIT checks the ID as well', () => {
  assert.deepEqual(errorsOf('FACTORY_RESET', {}), { confirm: 'Type FACTORY_RESET to confirm' });
  assert.deepEqual(errorsOf('FACTORY_RESET', { confirm: 'factory_reset' }), { confirm: 'Type FACTORY_RESET to confirm' });
  assert.deepEqual(errorsOf('FACTORY_RESET', { confirm: 'FACTORY_RESET' }), {});
  assert.deepEqual(errorsOf('INIT', { id: 'ABC', confirm: 'nope' }), { confirm: 'Type INIT to confirm' });
  assert.deepEqual(errorsOf('INIT', { id: 'bad id!', confirm: 'INIT' }), { id: 'id must be 1-32 letters or digits' });
  assert.deepEqual(checkCommand(command('INIT'), { id: 'ABC', confirm: 'INIT' }), { errors: {}, line: 'INIT|ABC' });
});

test('the forms hold the commands the page was asked for, in their groups', () => {
  const group = (name) => COMMANDS.filter((item) => item.group === name).map((item) => item.name);
  assert.deepEqual(group('identity'), ['GET_ID', 'SET_ID', 'INIT']);
  assert.deepEqual(group('wifi'), ['WIFI', 'WIFI_SEC', 'CLEAR_WIFI', 'NET']);
  assert.deepEqual(group('status'), ['STATS', 'STATUS', 'HELP']);
  assert.deepEqual(group('maintenance'), ['REBOOT', 'ENTER_BOOTLOADER', 'RESET_CONFIG', 'FACTORY_RESET']);
});

// The real firmware, where this checkout has it. A copy of cloud/ alone does not.
const FIRMWARE = new URL(process.env.CRANIUM_FIRMWARE_SRC ? `file://${process.env.CRANIUM_FIRMWARE_SRC}/` : '../../../firmware/app/src/', import.meta.url);

test('the table agrees with the firmware\'s table and limits', { skip: !existsSync(new URL('console_cmd.c', FIRMWARE)) }, () => {
  // A command that only a build with a test fault has is no command of a released board's, so
  // the page must not offer it.
  const source = readFileSync(new URL('console_cmd.c', FIRMWARE), 'utf8')
    .replace(/#if defined\(CONFIG_APP_TEST_FAULT_\w+\)[\s\S]*?#endif/g, '');
  const entry =/\{\s*"([A-Z_]+)",\s*(NULL|"\?"),\s*"[^"]*",\s*(?:"[^"]*"\s*)+,\s*SECTION_\w+,\s*(true|false),\s*(\d+),\s*(\d+),\s*cmd_\w+\s*\}/g;
  const firmware = new Map([...source.matchAll(entry)].map(([, name, alias, factory, min, max]) =>
    [name, { alias: alias === 'NULL' ? undefined : '?', factory: factory === 'true', args: [Number(min), Number(max)] }]));
  assert.equal(firmware.size >= 20, true, `found ${firmware.size} commands in console_cmd.c`);
  assert.deepEqual(COMMANDS.map((item) => item.name).sort(), [...firmware.keys()].sort());
  for (const item of COMMANDS) {
    const theirs = firmware.get(item.name);
    assert.deepEqual([item.alias, item.factory, item.args], [theirs.alias, theirs.factory, theirs.args], item.name);
  }
  const define = (file, name) => Number(new RegExp(`#define\\s+${name}\\s+(\\d+)`).exec(readFileSync(new URL(file, FIRMWARE), 'utf8'))[1]);
  assert.equal(define('device.h', 'DEVICE_ID_MAX'), 32);
  assert.equal(define('net.h', 'NET_SSID_MAX'), 32);
  assert.equal(define('net.h', 'NET_PASSWORD_MIN'), 8);
  assert.equal(define('net.h', 'NET_PASSWORD_MAX'), 63);
  assert.equal(define('console_parser.h', 'CONSOLE_LINE_MAX'), 384);
});

// Secrets.

test('a Wi-Fi command is masked however it was typed, and nothing of the password shows', () => {
  for (const [typed, shown] of [
    [`WIFI|Lab|${PASSWORD}`, `WIFI|Lab|${MASK}`],
    [`wifi|Lab|${PASSWORD}`, `wifi|Lab|${MASK}`],
    [`  WiFi |Lab|${PASSWORD}`, `WiFi|Lab|${MASK}`],
    [`WIFI_SEC|Lab|WPA3_SAE|${PASSWORD}`, `WIFI_SEC|Lab|WPA3_SAE|${MASK}`],
    [`wifi_sec|Lab|${PASSWORD}`, `wifi_sec|${MASK}`],
    [`WIFI_SEC|Lab|nonsense|${PASSWORD}`, `WIFI_SEC|${MASK}`],
    [`WIFI_SEC|Lab|wpa3_sae|${PASSWORD}`, `WIFI_SEC|Lab|wpa3_sae|${MASK}`],
    ['WIFI|battery-only', `WIFI|${MASK}`],
    ['WIFI|Lab|', `WIFI|Lab|${MASK}`],
    [`WFII|Lab|${PASSWORD}`, `WFII|${MASK}`],
  ]) {
    assert.equal(shownCommand(typed), shown, typed);
    assert.equal(shownCommand(typed).includes('battery'), false);
  }
  assert.equal(shownCommand('SET_ID|ABC123'), 'SET_ID|ABC123');
  assert.equal(holdsSecret('wifi|x'), true);
  assert.equal(holdsSecret('WIFI'), false);
  assert.equal(holdsSecret('NET'), false);
});

test('a password from the form reaches the board, and nowhere else: not the transcript, the history, storage or the page', async (t) => {
  const writes = watchStorage(t);
  const { board, session } = await connected(t);
  const { box } = drawn(session);
  const password = field(box, 'serial-WIFI-password');
  field(box, 'serial-WIFI-ssid').value = 'Lab';
  password.value = PASSWORD;
  assert.equal(password.getAttribute('type'), 'password');
  assert.equal(password.getAttribute('autocomplete'), 'new-password');
  click(one(all(box, 'form').find((form) => textOf(form).includes('Save a WPA2')), 'button'));
  assert.equal(password.value, '', 'cleared at once, before anything comes back');
  await settle();

  assert.equal(board.lines.at(-1), `WIFI|Lab|${PASSWORD}`, 'it did reach the board');
  assert.equal(board.lines.at(-2), 'ECHO|OFF', 'with the echo off first');
  assert.deepEqual(sentLines(session).at(-1), `WIFI|Lab|${MASK}`);
  assert.deepEqual(session.typed, []);
  assert.equal(JSON.stringify(session).includes('battery'), false);
  assert.equal(everythingShown(box).includes('battery'), false);
  assert.deepEqual(writes, []);
  // The bytes that were handed to the port are overwritten once the port has them.
  const last = board.handed.at(-1);
  assert.equal(last.every((byte) => byte === 0), true);
});

test('a password typed into the free input is hidden, masked, and left out of the history', async (t) => {
  const writes = watchStorage(t);
  const { board, session } = await connected(t);
  const { box, redraw } = drawn(session);
  const input = field(box, 'serial-typed');
  input.value = `wifi|Lab|${PASSWORD}`;
  input.dispatchEvent({ type: 'input' });
  redraw();
  await settle();
  assert.equal(input.getAttribute('type'), 'password', 'hidden while it is typed');
  one(box, 'form.serial-prompt').dispatchEvent({ type: 'submit' });
  assert.equal(input.value, '');
  await settle();
  redraw();

  assert.equal(board.lines.at(-1), `wifi|Lab|${PASSWORD}`);
  assert.equal(sentLines(session).at(-1), `wifi|Lab|${MASK}`);
  assert.deepEqual(session.typed, []);
  assert.equal(input.getAttribute('type'), 'text');
  assert.equal(JSON.stringify(session).includes('battery'), false);
  assert.equal(everythingShown(box).includes('battery'), false);
  assert.deepEqual(writes, []);
  input.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  assert.equal(input.value, '', 'the arrows bring nothing back');
});

test('a mistyped Wi-Fi command does not keep or show what follows its name either', async (t) => {
  const { session } = await connected(t, { reply: () => 'ERR unknown command WFII, type HELP\r\n' });
  const { box } = drawn(session);
  const input = field(box, 'serial-typed');
  input.value = `WFII|Lab|${PASSWORD}`;
  one(box, 'form.serial-prompt').dispatchEvent({ type: 'submit' });
  await settle();
  assert.equal(JSON.stringify(session).includes('battery'), false);
  assert.deepEqual(session.typed, []);
});

test('what the board echoes is masked too, even when it was not told to stop', async (t) => {
  const { board, session } = await connected(t);
  // As from a board that has restarted, before the page has told it again.
  board.send(`WIFI|Lab|${PASSWORD}\r\n`);
  board.send(`> wifi_sec|Lab|WPA3_SAE|${PASSWORD}\r\n`);
  await settle();
  assert.equal(JSON.stringify(session).includes('battery'), false);
  assert.deepEqual(session.lines.slice(-2).map((line) => line.text), [`WIFI|Lab|${MASK}`, `wifi_sec|Lab|WPA3_SAE|${MASK}`]);
  // HELP's list is not an echo: its lines start with a mark, and they are left as they are.
  board.send('  WIFI|<ssid>|<password>         save a WPA2 network and join it\r\n');
  await settle();
  assert.match(session.lines.at(-1).text, /<password>/);
});

test('no password is sent unless the board confirms that its echo is off', async (t) => {
  const { board, session } = await connected(t, {
    reply: (line) => (line === 'ECHO|OFF' ? '' : REPLIES[line.split('|')[0]]?.(line) ?? 'OK\r\n'),
  });
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(session.phase, 'ready');
  board.lines.length = 0;
  const sending = session.send(`WIFI|Lab|${PASSWORD}`);
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  const { sent, problem } = await sending;
  assert.equal(sent, false);
  assert.match(problem, /password was not sent/);
  assert.deepEqual(board.lines, ['ECHO|OFF']);
});

test('the page says where what is typed goes', async (t) => {
  const { session } = await connected(t);
  const { box } = drawn(session);
  assert.match(textOf(box), /goes only over the cable to the board, never to the server/);
});

// The free input.

test('what erases the board, and turning the echo back on, cannot be typed here', () => {
  assert.match(checkTyped('FACTORY_RESET').refused, /typed confirmation/);
  assert.match(checkTyped('  factory_reset').refused, /typed confirmation/);
  assert.match(checkTyped('init|ABC').refused, /typed confirmation/);
  assert.match(checkTyped('ECHO|ON').refused, /Echo stays off/);
  assert.match(checkTyped('echo| on ').refused, /Echo stays off/);
  assert.equal(checkTyped('ECHO|OFF').line, 'ECHO|OFF');
  assert.equal(checkTyped('   ').line, '');
  assert.match(checkTyped(`CLOUD|${'x'.repeat(400)}`).refused, /line too long, the limit is 384 bytes/);
  assert.match(checkTyped('NET\u0007').refused, /control character/);
  // The last argument is the board's to judge, spaces and all.
  assert.equal(checkTyped(`  WIFI|Lab|${PASSWORD}  `).line, `WIFI|Lab|${PASSWORD}  `);
});

test('the free input sends, keeps commands for the arrow keys, and refuses in words', async (t) => {
  const { board, session } = await connected(t);
  const { box, redraw } = drawn(session);
  const input = field(box, 'serial-typed');
  const type = async (text) => {
    input.value = text;
    one(box, 'form.serial-prompt').dispatchEvent({ type: 'submit' });
    await settle();
    redraw();
  };
  await type('NET');
  await type('NET');
  await type('STATS');
  assert.deepEqual(board.lines.slice(-3), ['NET', 'NET', 'STATS']);
  assert.deepEqual(session.typed, ['NET', 'STATS']);
  input.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  assert.equal(input.value, 'STATS');
  input.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  assert.equal(input.value, 'NET');
  input.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  input.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.equal(input.value, '');

  board.lines.length = 0;
  await type('FACTORY_RESET');
  assert.deepEqual(board.lines, []);
  assert.deepEqual(session.typed, ['NET', 'STATS']);
  assert.equal(input.value, 'FACTORY_RESET', 'left to be corrected');
  assert.match(textOf(one(box, 'p.serial-error')), /use its form/);
});

// The forms.

test('a form shows the firmware\'s words next to the field and sends nothing', async (t) => {
  const { board, session } = await connected(t);
  const { box } = drawn(session);
  board.lines.length = 0;
  const form = all(box, 'form').find((item) => textOf(item).includes('Change the ID'));
  field(box, 'serial-SET_ID-id').value = 'bad id!';
  click(one(form, 'button'));
  await settle();
  assert.deepEqual(board.lines, []);
  assert.match(textOf(form), /id must be 1-32 letters or digits/);
  assert.equal(field(box, 'serial-SET_ID-id').getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, field(box, 'serial-SET_ID-id'));
});

test('FACTORY_RESET and INIT go out only with the typed confirmation', async (t) => {
  const { board, session } = await connected(t);
  const { box } = drawn(session);
  board.lines.length = 0;
  const submit = (name) => click(one(all(box, 'form').find((item) => all(item, 'h3').some((title) => textOf(title) === name)), 'button'));

  submit('FACTORY_RESET');
  await settle();
  assert.deepEqual(board.lines, []);
  field(box, 'serial-FACTORY_RESET-confirm').value = 'FACTORY_RESET';
  submit('FACTORY_RESET');
  await settle();
  assert.deepEqual(board.lines, ['FACTORY_RESET']);
  assert.equal(field(box, 'serial-FACTORY_RESET-confirm').value, '', 'and it has to be typed again next time');

  board.lines.length = 0;
  field(box, 'serial-INIT-id').value = 'ABC123';
  submit('INIT');
  await settle();
  assert.deepEqual(board.lines, []);
  field(box, 'serial-INIT-confirm').value = 'INIT';
  submit('INIT');
  await settle();
  assert.deepEqual(board.lines, ['INIT|ABC123']);
});

test('a command without arguments goes out with one press, and its reply shows beside it', async (t) => {
  const { board, session } = await connected(t);
  const { box, redraw } = drawn(session);
  click(one(box, 'button', 'NET'));
  await settle();
  redraw();
  assert.equal(board.lines.at(-1), 'NET');
  assert.equal(textOf(one(box, 'p.serial-result')), 'OK');
});

test('every form and button is held back until a board answers', async (t) => {
  const { session } = await connected(t, {}, { connect: false });
  const { box } = drawn(session);
  assert.equal(one(box, 'fieldset').disabled, true);
  assert.equal(field(box, 'serial-typed').disabled, true);
  assert.match(textOf(box), /Connect a board to use these/);
  assert.equal(one(box, 'button', 'Connect a board').disabled, false);
});

// How replies read.

test('OK and ERR carry a word and an icon, and only final replies are read out', async (t) => {
  const { board, session } = await connected(t);
  board.send('[ota] Image verified\r\nnoise\r\nERR bad\r\n');
  await settle();
  const { box } = drawn(session);
  const ok = all(box, 'li.serial-line.is-ok').at(-1);
  const err = one(box, 'li.serial-line.is-err');
  assert.match(textOf(ok), /^OK/);
  assert.equal(all(ok, 'svg').length, 1);
  assert.match(textOf(err), /^ERR bad/);
  assert.equal(all(err, 'svg').length, 1);
  assert.equal(all(box, 'li.serial-line.is-tag').length, 1);
  assert.equal(textOf(one(box, 'span.serial-tag')), '[ota]');

  const live = descendants(box).filter((el) => el.hasAttribute('aria-live'));
  assert.equal(live.length, 1);
  assert.equal(textOf(live[0]), 'Error: bad');
  assert.equal(field(box, 'serial-transcript').hasAttribute('aria-live'), false);
  assert.equal(field(box, 'serial-transcript').getAttribute('tabindex'), '0');
  assert.equal(field(box, 'serial-transcript').getAttribute('role'), 'group', 'not role=log, which would read out every line');
});

test('a reply that repeats is still read out', async (t) => {
  const { board, session } = await connected(t);
  const { box, redraw } = drawn(session);
  const said = () => descendants(box).find((el) => el.hasAttribute('aria-live')).childNodes[0]?.textContent;
  board.send('OK same\r\n');
  await settle();
  redraw();
  const first = said();
  board.send('OK same\r\n');
  await settle();
  redraw();
  assert.notEqual(said(), first);
});

test('what the board sends is only ever text', async (t) => {
  const { board, session } = await connected(t);
  board.send('<img src=x onerror=alert(1)>\r\n');
  await settle();
  const { box } = drawn(session);
  assert.equal(all(box, 'img').length, 0);
  assert.match(textOf(box), /<img src=x/);
});

test('a viewer gets an explanation, and nothing that could reach a board', () => {
  const asked = [];
  const session = createSerialSession({ serial: { requestPort: async () => asked.push('port') } });
  const { box } = drawn(session, { canWrite: false });
  assert.match(textOf(box), /for release managers/);
  assert.deepEqual(all(box, 'input'), []);
  assert.deepEqual(all(box, 'button'), []);
  assert.deepEqual(asked, []);
});

test('a browser without Web Serial gets an explanation, the alternative, and no controls', () => {
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  views.render(box, serial.serialView({ state: { me: { canWrite: true } }, actions: {} }));
  assert.match(textOf(box), /Chrome and Edge/);
  assert.match(textOf(box), /secure/);
  assert.match(textOf(box), /plain serial monitor at 115200 baud/);
  assert.deepEqual(all(box, 'input'), []);
  assert.deepEqual(all(box, 'button'), []);
});
