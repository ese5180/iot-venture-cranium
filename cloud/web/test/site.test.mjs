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
      ...source.matchAll(/\b(?:description|live)\('[a-z]+', '([a-z-]+)'/g),
      ...source.matchAll(/badge\('[a-z]+', '([a-z-]+)'/g),
      ...source.matchAll(/\['[a-zA-Z]+', '[a-z ]+', '(?:good|live|wait|warn|bad|idle)', '([a-z-]+)'\]/g),
    ].map((match) => match[1]);
    for (const icon of asked) assert.equal(drawn.has(icon), true, `${name} asks for the icon ${icon}`);
  }
});

// The stylesheet, read as rules. It is written plainly, with at most one @media or
// @container block around a rule, so two passes over its blocks are enough.

/** The blocks of a piece of CSS at its top level, as [prelude, body]. */
function blocks(text) {
  const found = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') {
      if (depth === 0) open = index;
      depth += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        found.push([text.slice(start, open).trim(), text.slice(open + 1, index)]);
        start = index + 1;
      }
    }
  }
  return found;
}

/** Every rule of the stylesheet as { media, selectors, values }; `media` is '' outside a block. */
function readRules(text) {
  const rules = [];
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const add = (media, [prelude, body]) => {
    const values = new Map();
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon !== -1) values.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    rules.push({ media, selectors: prelude.split(',').map((selector) => selector.trim()), values });
  };
  for (const block of blocks(plain)) {
    if (/^@(?:media|container)\b/.test(block[0])) {
      for (const inner of blocks(block[1])) add(block[0], inner);
    } else if (!block[0].startsWith('@')) {
      add('', block);
    }
  }
  return rules;
}

const rules = readRules(css);

/** What the stylesheet declares for a selector, outside any block or inside the one named. */
function declared(selector, media = '') {
  const values = new Map();
  for (const rule of rules) {
    if (rule.media === media && rule.selectors.includes(selector)) {
      for (const [name, value] of rule.values) values.set(name, value);
    }
  }
  return values;
}

test('the sections in the masthead are never squeezed under the account block', () => {
  // In one row the sections keep their width and the account block gives way, its
  // texts ending in an ellipsis. A link can therefore never lie under another box.
  assert.equal(declared('.nav').get('flex'), '1 0 auto');
  assert.equal(declared('.nav').has('min-width'), false);
  assert.equal(declared('.brand').get('flex'), 'none');
  assert.equal(declared('.account').get('flex'), '0 1 auto');
  assert.equal(declared('.account').get('min-width'), '0');
  for (const selector of ['.account-email', '.account-session']) {
    assert.equal(declared(selector).get('overflow'), 'hidden', selector);
    assert.equal(declared(selector).get('text-overflow'), 'ellipsis', selector);
  }

  // Below the width that one row needs, the sections take a row of their own. The two
  // narrower layouts meet without a gap between them.
  const media = [...new Set(rules.map((rule) => rule.media))];
  const twoRows = media.find((name) => /^@media \(min-width: 861px\) and \(max-width: \d+px\)$/.test(name));
  assert.notEqual(twoRows, undefined, 'a layout between the phone and the full width');
  assert.equal(Number(/max-width: (\d+)px/.exec(twoRows)[1]) >= 1100, true);
  assert.equal(declared('.nav', twoRows).get('flex-basis'), '100%');
  assert.equal(declared('.masthead-inner', twoRows).get('flex-wrap'), 'wrap');
  const threeRows = '@media (max-width: 860px)';
  assert.equal(declared('.nav', threeRows).get('flex-basis'), '100%');
  assert.equal(declared('.masthead-inner', threeRows).get('flex-wrap'), 'wrap');
});

/** The contrast of two colours as WCAG defines it, from "#rrggbb". */
function contrast(first, second) {
  const luminance = (hex) => {
    const [red, green, blue] = [1, 3, 5].map((at) => {
      const part = parseInt(hex.slice(at, at + 2), 16) / 255;
      return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('lettering on a filled button or a tinted panel is readable in both themes', () => {
  const themes = {
    light: declared(':root'),
    dark: new Map([...declared(':root'), ...declared(':root', '@media (prefers-color-scheme: dark)')]),
  };
  // [lettering, what it stands on]
  const pairs = [
    ['--on-accent', '--accent'],
    ['--on-bad-fill', '--bad-fill'],
    ['--ink', '--accent-wash'],
    ['--ink', '--good-wash'],
    ['--ink', '--warn-wash'],
    ['--ink', '--bad-wash'],
    ['--ink', '--well'],
    ['--ink-2', '--surface'],
    ['--ink-3', '--paper'],
    ['--paper', '--ink'],
  ];
  for (const [name, colours] of Object.entries(themes)) {
    for (const [text, ground] of pairs) {
      for (const token of [text, ground]) {
        assert.match(colours.get(token) ?? '', /^#[0-9a-f]{6}$/, `${token} in the ${name} theme`);
      }
      const ratio = contrast(colours.get(text), colours.get(ground));
      assert.equal(ratio >= 4.5, true, `${text} on ${ground}, ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
  // A button that destroys something is filled with a red that carries light lettering
  // in both themes: the lettering is closer to white than the fill is.
  assert.equal(declared('.btn.is-danger').get('background'), 'var(--bad-fill)');
  assert.equal(declared('.btn.is-danger').get('color'), 'var(--on-bad-fill)');
  for (const [name, colours] of Object.entries(themes)) {
    const toWhite = (token) => contrast(colours.get(token), '#ffffff');
    assert.equal(toWhite('--on-bad-fill') < toWhite('--bad-fill'), true, name);
  }
});

test('a state that asks for somebody has a look of its own, and motion is never needed to read one', () => {
  assert.equal(rules.some((rule) => rule.selectors.includes('.execution.is-act .execution-state')), true);
  assert.equal(declared('.execution.is-act .execution-state').get('background'), 'var(--accent-wash)');
  // With reduced motion the bar that waits for the server is not left standing part full.
  const still = '@media (prefers-reduced-motion: reduce)';
  assert.equal(declared('.meter.is-busy .meter-fill', still).get('width'), '100%');
});

test('no file of the site contains an e-mail address', () => {
  for (const [name, text] of [...sources, ['index.html', page], [styles[0], css]]) {
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
  }
});
