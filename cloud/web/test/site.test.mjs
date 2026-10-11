/**
 * Checks on the files of the site themselves: that a cold load stays within five
 * requests, and that nothing in them needs what the page's content security policy
 * forbids or writes markup into the document.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const SITE = new URL('../src/site/', import.meta.url);

function visible(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
}

const assets = visible(new URL('assets/', SITE)).map((entry) => entry.name).sort();
const scripts = assets.filter((name) => name.endsWith('.js'));
const styles = assets.filter((name) => name.endsWith('.css'));
const read = (name) => readFileSync(new URL(name, SITE), 'utf8');
const page = read('index.html');
const sources = new Map(scripts.map((name) => [name, read(`assets/${name}`)]));
const css = read(`assets/${styles[0]}`);

/** Script text without comments, so that a rule may be explained without tripping it. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

test('a cold load is at most five requests: the page, one stylesheet, three scripts', () => {
  assert.deepEqual(visible(SITE).map((entry) => entry.name).sort(), ['assets', 'index.html']);
  assert.equal(visible(new URL('assets/', SITE)).every((entry) => entry.isFile()), true);
  assert.equal(styles.length, 1);
  assert.equal(scripts.length >= 1 && scripts.length <= 3, true, `${scripts.length} scripts`);
  assert.equal(assets.length, styles.length + scripts.length,
    `only stylesheets and scripts: ${assets.join(', ')}`);
  assert.equal(1 + assets.length <= 5, true);
});

test('the page refers to its files under the build id and to nothing else', () => {
  const references = [...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => match[1]);
  const fetched = references.filter((reference) => !/^(#|data:)/.test(reference));
  assert.deepEqual([...new Set(fetched)].sort(), assets.map((name) => `/assets/%BUILD%/${name}`).sort());

  // The icon is inline, so the browser does not ask for /favicon.ico.
  assert.match(page, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.equal((page.match(/%CONFIG%/g) ?? []).length, 1);
  assert.match(page, /<meta name="cranium-config" content="%CONFIG%">/);
});

test('scripts import only each other, by relative path', () => {
  const reachable = new Set();
  const entry = /<script type="module" src="\/assets\/%BUILD%\/([a-z.]+)"><\/script>/.exec(page)[1];
  const visit = (name) => {
    if (reachable.has(name)) return;
    assert.equal(sources.has(name), true, `${name} is imported but is not in the site`);
    reachable.add(name);
    const source = code(sources.get(name));
    assert.doesNotMatch(source, /\bimport\s*\(/, `${name} must not import on demand`);
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      assert.match(match[1], /^\.\/[a-z]+\.js$/, `${name} imports ${match[1]}`);
      visit(match[1].slice(2));
    }
  };
  visit(entry);
  assert.deepEqual([...reachable].sort(), scripts, 'every script in the site is loaded, and none twice');
});

test('the page has no inline script, style or event handler', () => {
  assert.doesNotMatch(page, /<style[\s>]/i);
  assert.doesNotMatch(page, /\sstyle\s*=/i);
  assert.doesNotMatch(page, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(page, /javascript:/i);
  for (const match of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(match[1], /\ssrc="/, 'a script element must load a file');
    assert.equal(match[2].trim(), '', 'a script element must be empty');
  }
  assert.match(page, /Loading the console… reload the page if this does not go away\./);
  assert.match(page, /<noscript>[\s\S]+<\/noscript>/);
});

test('scripts never write markup into the page or run text as code', () => {
  const forbidden = [
    [/\.innerHTML\b/, 'innerHTML'],
    [/\.outerHTML\b/, 'outerHTML'],
    [/insertAdjacentHTML/, 'insertAdjacentHTML'],
    [/document\.write/, 'document.write'],
    [/createContextualFragment|DOMParser|setHTML/, 'parsing markup'],
    [/\beval\s*\(/, 'eval'],
    [/new\s+Function\b/, 'new Function'],
    [/set(?:Timeout|Interval)\s*\(\s*['"`]/, 'a timer given text to run'],
    [/javascript:/i, 'a javascript: address'],
    [/\.srcdoc\b/, 'srcdoc'],
  ];
  for (const [name, source] of sources) {
    for (const [pattern, what] of forbidden) {
      assert.doesNotMatch(code(source), pattern, `${name} uses ${what}`);
    }
  }
});

test('scripts set no inline styles: custom properties through setProperty only', () => {
  for (const [name, source] of sources) {
    const text = code(source);
    assert.doesNotMatch(text, /setAttribute\(\s*['"]style['"]/, `${name} sets a style attribute`);
    assert.doesNotMatch(text, /\.cssText\b/, `${name} sets cssText`);
    for (const match of text.matchAll(/\.style\.(\w+)/g)) {
      assert.match(match[1], /^(?:setProperty|removeProperty)$/, `${name} uses style.${match[1]}`);
    }
  }
});

test('the access token is kept for the tab only, and randomness comes from the CSPRNG', () => {
  for (const [name, source] of sources) {
    const text = code(source);
    assert.doesNotMatch(text, /localStorage|indexedDB|document\.cookie/,
      `${name} keeps something beyond the tab`);
    assert.doesNotMatch(text, /Math\.random/, `${name} uses Math.random`);
  }
});

test('nothing is fetched from anywhere else', () => {
  const namespaces = /http:\/\/www\.w3\.org\/2000\/svg/g;
  for (const [name, text] of [...sources, ['index.html', page], [styles[0], css]]) {
    assert.doesNotMatch(text.replace(namespaces, ''), /https?:\/\/[a-z0-9]/i, `${name} names another site`);
  }
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(/);
  assert.doesNotMatch(css, /@font-face/);
});

test('both colour schemes and reduced motion are provided for', () => {
  assert.match(css, /--paper: #faf7f2;/);
  assert.match(css, /--accent: #b7410e;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /--paper: #171411;/);
  assert.match(css, /--surface: #211d19;/);
  assert.match(css, /--accent: #e2703a;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

test('every icon a description asks for is drawn', () => {
  const drawn = new Set();
  const table = /const ICONS = \{([\s\S]*?)\n\};/.exec(sources.get('views.js'))[1];
  for (const match of table.matchAll(/^ {2}(?:'([a-z-]+)'|([a-z]+)): \[/gm)) drawn.add(match[1] ?? match[2]);
  assert.equal(drawn.size > 20, true);

  for (const [name, source] of sources) {
    const asked = [
      ...source.matchAll(/\bicon(?:Name)?: '([a-z-]+)'/g),
      ...source.matchAll(/\bicon\('([a-z-]+)'/g),
      ...source.matchAll(/describe\('[a-z]+', '([a-z-]+)'/g),
      ...source.matchAll(/badge\('[a-z]+', '([a-z-]+)'/g),
      ...source.matchAll(/\['[a-zA-Z]+', '[a-z ]+', '(?:good|live|wait|warn|bad|idle)', '([a-z-]+)'\]/g),
    ].map((match) => match[1]);
    for (const icon of asked) assert.equal(drawn.has(icon), true, `${name} asks for the icon ${icon}`);
  }
});

test('no file of the site contains an e-mail address', () => {
  for (const [name, text] of [...sources, ['index.html', page], [styles[0], css]]) {
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
  }
});
