/**
 * Tests for the public home page: which host names get it, that the console does not
 * change because of it, what is on it, and what the template and the deployment script
 * promise about it.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWebHandler, handler, loadSite } from '../src/server.mjs';

const SITE = new URL('../src/site/', import.meta.url);
const HOME = 'home.example.test';
const WWW = `www.${HOME}`;
const CONSOLE = 'console.example.test';
const LOGIN = 'https://cranium-0a1b2c3d.auth.region-1.login.test';
const SETTINGS = { clientId: 'client-id-for-tests', loginOrigin: LOGIN, scope: 'openid cranium/console' };

const HOME_CSP = "default-src 'none'; style-src 'self'; img-src data:; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

const read = (name) => readFileSync(new URL(name, SITE), 'utf8');
const html = read('home.html');
const css = read('assets/home.css');
const consoleCss = read('assets/app.css');
const template = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const deployScript = readFileSync(new URL('../../deploy.sh', import.meta.url), 'utf8');

function request(rawPath, domainName, method = 'GET') {
  return { rawPath, requestContext: { requestId: 'request-1', domainName, http: { method } } };
}

const quiet = (settings) => createWebHandler({ ...settings, log: () => {} });
const serve = quiet({ ...SETTINGS, homeHosts: [HOME, WWW] });
const site = loadSite(SITE);

test('a console host gets the same bytes and headers as when there is no home page', async () => {
  const without = quiet(SETTINGS);
  const paths = ['/', '/nothing', '/assets/000000000000/app.js', ...site.console.assets.keys()];
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'HEAD']) {
      assert.deepEqual(await serve(request(path, CONSOLE, method)), await without(request(path, CONSOLE, method)),
        `${method} ${path}`);
    }
  }
  const page = await serve(request('/', CONSOLE));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<meta name="cranium-config" content="[^"]+">/);
  assert.match(page.body, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(page.headers['content-security-policy'], new RegExp(`connect-src 'self' ${LOGIN};`));
});

test('an unknown host gets the console, and only the exact names get the home page', async () => {
  for (const name of ['other.example.test', `x.${HOME}`, `www.${WWW}`, `${HOME}.evil.example`, 'example.test',
    'a1b2c3d4e5.execute-api.region-1.cloud.test']) {
    const page = await serve(request('/', name));
    assert.equal(page.statusCode, 200, name);
    assert.match(page.body, /cranium-config/, name);
    assert.equal(JSON.parse(/content="([^"]+)"/.exec(page.body.split('cranium-config')[1])[1].replaceAll('&quot;', '"'))
      .redirectUri, `https://${name}/`);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/, name);
  }
  // What is not a host name in lower case is refused as it always was, not repaired.
  for (const name of [HOME.toUpperCase(), `${HOME}.`, `${HOME}:443`, '', undefined, null, 7, ['x']]) {
    const page = await serve(request('/', name));
    assert.equal(page.statusCode, 400, String(name));
  }
});

test('a home host gets the home page, with a stricter policy and none of the console\'s settings', async () => {
  for (const name of [HOME, WWW]) {
    const page = await serve(request('/', name));
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.equal(page.headers['content-security-policy'], HOME_CSP);
    assert.match(page.body, /^<!doctype html>/);
    assert.doesNotMatch(page.body, /%BUILD%|%CONFIG%|cranium-config/);
    const everything = JSON.stringify(page);
    for (const secretless of [SETTINGS.clientId, LOGIN, 'cranium/console', 'oauth2']) {
      assert.equal(everything.includes(secretless), false, secretless);
    }
  }
});

test('every reply on a home host carries the same security headers as the console', async () => {
  const consolePage = await serve(request('/', CONSOLE));
  const stylesheet = [...site.home.assets.keys()][0];
  for (const [path, method] of [['/', 'GET'], [stylesheet, 'GET'], ['/nothing', 'GET'], ['/', 'HEAD'], ['/', 'POST']]) {
    const { headers } = await serve(request(path, HOME, method));
    assert.equal(headers['content-security-policy'], HOME_CSP, `${method} ${path}`);
    for (const name of ['strict-transport-security', 'x-content-type-options', 'referrer-policy',
      'cross-origin-opener-policy', 'cross-origin-resource-policy']) {
      assert.equal(headers[name], consolePage.headers[name], `${method} ${path}: ${name}`);
    }
    // The same, except that only the console has a page that uses a serial port.
    assert.match(headers['permissions-policy'], /(^|, )serial=\(\)(,|$)/, `${method} ${path}`);
    assert.equal(headers['permissions-policy'],
      consolePage.headers['permissions-policy'].replace('serial=(self)', 'serial=()'), `${method} ${path}`);
  }
  const head = await serve(request('/', HOME, 'HEAD'));
  assert.equal(head.statusCode, 405);
  assert.equal(head.headers.allow, 'GET');
});

test('a home host serves its stylesheet and cannot reach a file of the console', async () => {
  assert.deepEqual([...site.home.assets.keys()], [`/assets/${site.home.buildId}/home.css`]);
  const stylesheet = await serve(request(`/assets/${site.home.buildId}/home.css`, HOME));
  assert.equal(stylesheet.statusCode, 200);
  assert.equal(stylesheet.body, css);
  assert.equal(stylesheet.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(stylesheet.headers['cache-control'], 'public, max-age=31536000, immutable');

  const paths = [...site.console.assets.keys(), '/index.html', '/home.html',
    `/assets/${site.home.buildId}/app.js`, `/assets/${site.home.buildId}/index.html`,
    `/assets/${site.console.buildId}/home.css`, '/api/', '/api/me'];
  for (const path of paths) {
    const reply = await serve(request(path, HOME));
    assert.equal(reply.statusCode, 404, path);
    assert.equal(reply.body, 'Not found\n');
    assert.equal(reply.headers['cache-control'], 'no-store');
  }
});

test('a console host cannot reach the home page or its stylesheet', async () => {
  for (const path of [...site.home.assets.keys(), '/home.html', `/assets/${site.console.buildId}/home.css`]) {
    assert.equal((await serve(request(path, CONSOLE))).statusCode, 404, path);
  }
});

test('everything the home page refers to is served, from the same host', async () => {
  const page = await serve(request('/', HOME));
  const links = [...page.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(links.sort(), ['/', `/assets/${site.home.buildId}/home.css`]);
  for (const link of links) assert.equal((await serve(request(link, HOME))).statusCode, 200, link);
});

test('a list of home hosts that is not a list of host names is refused when the handler is made', () => {
  for (const homeHosts of ['one.example', [HOME.toUpperCase()], ['two words.example'], [`${HOME},${WWW}`], [''],
    [7], [null], [`${HOME}:443`], ['-leading.example']]) {
    assert.throws(() => createWebHandler({ ...SETTINGS, homeHosts }), TypeError, JSON.stringify(homeHosts));
  }
});

test('HOME_HOSTS names the home hosts, and left out or empty there are none', async (t) => {
  const names = ['USER_POOL_CLIENT_ID', 'LOGIN_DOMAIN', 'OAUTH_SCOPE', 'HOME_HOSTS'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const consoleLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = consoleLog;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.USER_POOL_CLIENT_ID = 'deployed-client';
  process.env.OAUTH_SCOPE = 'openid cranium/console';
  process.env.LOGIN_DOMAIN = LOGIN.slice('https://'.length);

  // The handler keeps its settings once made, so each case needs a module of its own.
  const fresh = async (value, tag) => {
    if (value === undefined) delete process.env.HOME_HOSTS;
    else process.env.HOME_HOSTS = value;
    return (await import(`../src/server.mjs?${tag}`)).handler;
  };

  for (const [value, tag] of [[undefined, 'absent'], ['', 'empty']]) {
    const page = await (await fresh(value, tag))(request('/', HOME));
    assert.match(page.body, /cranium-config/, tag);
  }

  const deployed = await fresh(`${HOME},${WWW}`, 'both');
  for (const name of [HOME, WWW]) {
    assert.equal((await deployed(request('/', name))).headers['content-security-policy'], HOME_CSP);
  }
  assert.match((await deployed(request('/', CONSOLE))).body, /cranium-config/);

  const refusing = await fresh(`${HOME}, ${WWW}`, 'space');
  await assert.rejects(refusing(request('/', CONSOLE)), TypeError);

  assert.equal(typeof handler, 'function');
});

/** A copy of the site to change, and a way to load it. */
function copyOfSite(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cranium-site-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(fileURLToPath(SITE), directory, { recursive: true });
  return { directory, load: () => loadSite(pathToFileURL(`${directory}/`)) };
}

test('a change to the home page does not change a byte of the console', (t) => {
  const { directory, load } = copyOfSite(t);
  const before = load();
  assert.deepEqual(before, site);

  writeFileSync(join(directory, 'assets', 'home.css'), `${css}\n/* changed */\n`);
  writeFileSync(join(directory, 'home.html'), html.replace('Cranium', 'Cranium changed'));
  const after = load();
  assert.deepEqual(after.console, before.console);
  assert.notEqual(after.home.buildId, before.home.buildId);

  writeFileSync(join(directory, 'assets', 'app.css'), `${consoleCss}\n/* changed */\n`);
  const later = load();
  assert.notEqual(later.console.buildId, after.console.buildId);
  assert.equal(later.home.buildId, after.home.buildId);
});

test('the function does not start with a file in the site that it does not expect', (t) => {
  const unexpected = /Unexpected entry in site\//;
  const strays = [
    ['a page beside the two', unexpected, (directory) => writeFileSync(join(directory, 'about.html'), 'x')],
    ['a script for the home page', unexpected, (directory) => writeFileSync(join(directory, 'assets', 'home.js'), 'x')],
    ['a second home stylesheet', unexpected, (directory) => writeFileSync(join(directory, 'assets', 'home.print.css'), 'x')],
    ['an image', unexpected, (directory) => writeFileSync(join(directory, 'assets', 'logo.png'), 'x')],
    ['a subdirectory', unexpected, (directory) => mkdirSync(join(directory, 'assets', 'more'))],
    ['settings in the home page', /must not contain %CONFIG%/, (directory) => writeFileSync(join(directory, 'home.html'), `${html}%CONFIG%`)],
    ['no home page', /ENOENT/, (directory) => rmSync(join(directory, 'home.html'))],
    ['no home stylesheet', /home\.css is missing/, (directory) => rmSync(join(directory, 'assets', 'home.css'))],
  ];
  for (const [name, expected, add] of strays) {
    const { directory, load } = copyOfSite(t);
    load();
    add(directory);
    assert.throws(load, expected, name);
  }
});

test('the page has no script, no inline style and no event handler', () => {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<(?:img|iframe|object|embed|form|input|video|audio)\b/i);
});

test('the page says what it is, and that it is in development', () => {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  for (const fact of ['mounted attachment', 'Pioneer FLX4', 'without the laptop', 'Bluetooth audio', 'Raspberry Pi',
    'In development', 'student team at Penn', 'not for sale']) {
    assert.ok(text.includes(fact), fact);
  }
  for (const fact of ['ECDSA P-256', 'MCUboot', 'Button 1', 'previous image back', 'Automatic rollback']) {
    assert.ok(text.includes(fact), fact);
  }
});

test('the page says no more than the project\'s own documents do', () => {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&ndash;/g, '-').replace(/\s+/g, ' ');
  // What the update path promises holds over the air, and it says so.
  assert.ok(text.includes('Over the air, a board takes only what was signed'));
  assert.doesNotMatch(text, /A board runs only what was signed/);
  assert.doesNotMatch(text, /it only verifies and swaps/);
  // What is not built is said, and what is built only as a design is told as a design.
  assert.ok(text.includes('The board has no audio yet'));
  assert.ok(text.includes('How it is designed to connect'));
  assert.ok(text.includes('The enclosure and the mount'));
  assert.ok(text.includes('Updating the Raspberry Pi with RAUC'));
  assert.ok(text.includes('To be authenticated before it reaches your other devices'));
  // The limits that the documents state and a reader of them would look for.
  for (const limit of ['Serial recovery', 'no version check', 'network core', 'device key', 'debug port is open', 'TLS 1.2',
    'not encrypted', 'no hardware counter', 'no such build yet']) {
    assert.ok(text.includes(limit), limit);
  }
  // The number of download attempts is the firmware's default.
  const kconfig = readFileSync(new URL('../../../firmware/app/Kconfig', import.meta.url), 'utf8');
  assert.match(kconfig, /config APP_OTA_DOWNLOAD_ATTEMPTS[\s\S]*?default 5\b/);
  assert.ok(text.includes('up to five attempts'));
  // Measured results, with what they do not cover.
  assert.ok(text.includes('181-227'));
  assert.ok(text.includes('with earlier firmware'));
  assert.ok(text.includes('not through the console'));
});

test('the page links to the console and the repository, and fetches nothing elsewhere', () => {
  assert.match(html, /<a class="[^"]*" href="https:\/\/console\.craniumiot\.com">Developer console<\/a>/);
  const links = new Set([...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((match) => match[1]));
  for (const link of links) {
    assert.ok(/^(?:#[a-z]+|\/|https:\/\/console\.craniumiot\.com|https:\/\/github\.com\/ese5180\/f26-t07-the-cranium)$/.test(link), link);
  }
  assert.ok(links.has('https://github.com/ese5180/f26-t07-the-cranium'));
  // Every in-page link has somewhere to go.
  for (const link of links) {
    if (link.startsWith('#')) assert.ok(html.includes(` id="${link.slice(1)}"`), link);
  }
  const resources = [...html.matchAll(/<link\b[^>]*\srel="([^"]+)"[^>]*\shref="([^"]+)"/g)]
    .map((match) => [match[1], match[2].slice(0, 22)]);
  assert.deepEqual(resources, [
    ['canonical', 'https://craniumiot.com'],
    ['icon', 'data:image/svg+xml,%3C'],
    ['stylesheet', '/assets/%BUILD%/home.c'],
  ]);
});

test('the page invents nothing: no price, sale, customer, person or address', () => {
  const words = html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ');
  for (const pattern of [/[$€£]/, /@/, /\bprices?\b/i, /\bbuy\b/i, /\bpurchase/i, /\bpre-?order/i, /\bcustomers?\b/i,
    /\btestimonial/i, /\bmarket/i, /\brevenue/i, /\bships?\b/i, /\bshipping\b/i, /\bavailable\b/i, /\bsubscribe\b/i,
    /\bwaitlist\b/i, /\bBosket\b/i, /\bShalabi\b/i, /\bDurante\b/i, /\bRavishankar\b/i, /\bupenn\b/i, /\bMemfault\b/i,
    /\barn:/i, /amazonaws/i, /execute-api/i, /amazoncognito/i, /\b20\d\d\b/]) {
    assert.doesNotMatch(words, pattern);
  }
});

test('the stylesheet needs nothing from elsewhere, and provides for both themes and for reduced motion', () => {
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(/);
  assert.doesNotMatch(css, /@font-face/);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  const reduced = css.split('@media (prefers-reduced-motion: reduce)')[1];
  assert.match(reduced, /animation: none !important/);
  assert.match(reduced, /transition: none !important/);
  // Without its animation a groove would stay undrawn.
  assert.match(reduced, /\.art-groove \{\s+stroke-dashoffset: 0;/);
  // The heaviest rule of the panel in the dark theme, where it is what sets it off from the page.
  assert.match(css, /box-shadow: inset 0 3px 0 var\(--ink\)/);
});

/** The colour tokens of the block that follows this text, as name -> value. */
function colours(text, after, start = 0) {
  const at = text.indexOf(after, start);
  assert.notEqual(at, -1, after);
  const open = text.indexOf('{', at + after.length - 1);
  const close = text.indexOf('}', open);
  const found = new Map();
  for (const [, name, value] of text.slice(open, close).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{3,8});/g)) {
    found.set(name, value);
  }
  assert.equal(found.size > 0, true, after);
  return found;
}

test('the home page uses the console\'s colours, value for value, in both themes and on ink', () => {
  const darkOf = (text) => text.indexOf('@media (prefers-color-scheme: dark)');
  const darkInkOf = (text) => text.indexOf('@media (prefers-color-scheme: dark)', darkOf(text) + 1);
  const blocks = [
    ['light', (text) => colours(text, ':root {')],
    ['dark', (text) => colours(text, ':root {', darkOf(text))],
    ['ink', (text) => colours(text, '.on-ink')],
    ['dark ink', (text) => colours(text, '.on-ink', darkInkOf(text))],
  ];
  for (const [name, of] of blocks) {
    const console = of(consoleCss);
    for (const [token, value] of of(css)) {
      assert.equal(value, console.get(token), `${name}: ${token}`);
    }
  }
});

/** The line that says `key:` at this indentation, with everything indented below it. */
function block(text, key, indent = 2) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}${key}:`));
  assert.notEqual(start, -1, `${key} is missing`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('the template sends what no route claims to the web function, and opens nothing else', () => {
  const route = block(template, 'DefaultRoute');
  assert.ok(route.includes('RouteKey: $default'));
  assert.ok(route.includes('AuthorizationType: NONE'));
  assert.ok(route.includes('integrations/${WebIntegration}'));

  // The whole list of routes, whatever each one is called: every resource of that type.
  const routes = template.split('\n')
    .filter((line) => /^ {2}\w+:$/.test(line))
    .map((line) => block(template, line.trim().slice(0, -1)))
    .filter((text) => text.includes('Type: AWS::ApiGatewayV2::Route'));
  const open = routes.filter((text) => text.includes('AuthorizationType: NONE'));
  const keyOf = (text) => /RouteKey: '?([^'\n]+)'?/.exec(text)[1];
  assert.deepEqual(open.map(keyOf).sort(), ['$default', 'GET /', 'GET /assets/{proxy+}']);
  for (const text of open) assert.ok(text.includes('integrations/${WebIntegration}'), keyOf(text));

  const guarded = routes.filter((text) => !text.includes('AuthorizationType: NONE'));
  assert.deepEqual(guarded.map(keyOf).sort(), ['GET /api/{proxy+}', 'POST /api/{proxy+}']);
  for (const text of guarded) {
    assert.ok(text.includes('AuthorizationType: JWT'), keyOf(text));
    assert.ok(text.includes('integrations/${ApiIntegration}'), keyOf(text));
  }
});

test('the home page\'s names are optional, and do nothing unless they are set', () => {
  const parameters = block(template, 'Parameters', 0);
  for (const name of ['HomeDomainName', 'HomeCertificateArn']) {
    assert.ok(block(parameters, name).includes("Default: ''"), name);
    assert.ok(block(parameters, name).includes("AllowedPattern: '^$|"), name);
  }
  assert.ok(template.includes("HasHomeDomain: !Not [!Equals [!Ref HomeDomainName, '']]"));

  for (const [resource, type] of [['HomeDomain', 'DomainName'], ['HomeDomainMapping', 'ApiMapping'],
    ['HomeWwwDomain', 'DomainName'], ['HomeWwwDomainMapping', 'ApiMapping']]) {
    const text = block(template, resource);
    assert.ok(text.includes(`Type: AWS::ApiGatewayV2::${type}`), resource);
    assert.ok(text.includes('Condition: HasHomeDomain'), resource);
  }
  assert.ok(block(template, 'HomeDomain').includes('DomainName: !Ref HomeDomainName'));
  assert.ok(block(template, 'HomeWwwDomain').includes("DomainName: !Sub 'www.${HomeDomainName}'"));
  assert.ok(block(template, 'HomeDomainMapping').includes('DomainName: !Ref HomeDomain\n'));
  assert.ok(block(template, 'HomeWwwDomainMapping').includes('DomainName: !Ref HomeWwwDomain\n'));

  const hosts = block(block(template, 'WebFn'), 'HOME_HOSTS', 10);
  assert.ok(hosts.includes('- HasHomeDomain'));
  assert.ok(hosts.includes("- !Sub '${HomeDomainName},www.${HomeDomainName}'"));
  assert.ok(hosts.includes('- !Ref AWS::NoValue'));

  const outputs = block(template, 'Outputs', 0);
  for (const [output, value] of [['HomeUrl', "https://${HomeDomainName}/"],
    ['HomeDomainTarget', '!GetAtt HomeDomain.RegionalDomainName'],
    ['HomeWwwDomainTarget', '!GetAtt HomeWwwDomain.RegionalDomainName']]) {
    assert.ok(block(outputs, output).includes('Condition: HasHomeDomain'), output);
    assert.ok(block(outputs, output).includes(value), output);
  }
});

test('Cognito is not told about the home page', () => {
  for (const resource of ['UserPool', 'UserPoolClient', 'UserPoolDomain']) {
    assert.equal(/Home/.test(block(template, resource)), false, resource);
  }
});

test('deploy.sh takes the home page\'s two parameters', () => {
  const accepted = /^\s+([A-Za-z=*|]+)\)$/m;
  const line = deployScript.split('\n').find((text) => text.includes('ConsoleCertificateArn=*'));
  assert.match(line, accepted);
  assert.ok(line.includes('HomeDomainName=*'));
  assert.ok(line.includes('HomeCertificateArn=*'));
  assert.ok(deployScript.split('\n\n')[0].includes('HomeDomainName'), 'the usage names it');
});
