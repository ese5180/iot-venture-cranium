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

// The console's files. The home page's own two are checked in home.test.mjs. history.json
// is only there once something wrote it, and is checked in history.test.mjs.
const HISTORY_DATA = 'history.json';
const assets = visible(new URL('assets/', SITE)).map((entry) => entry.name)
  .filter((name) => !name.startsWith('home.') && name !== HISTORY_DATA).sort();
const scripts = assets.filter((name) => name.endsWith('.js'));
// Each belongs to one page and is fetched when that page is opened.
const ON_DEMAND = ['history.js', 'serial.js'];
const atOnce = assets.filter((name) => !ON_DEMAND.includes(name));
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
  assert.deepEqual(visible(SITE).map((entry) => entry.name).sort(), ['assets', 'home.html', 'index.html']);
  assert.equal(visible(new URL('assets/', SITE)).every((entry) => entry.isFile()), true);
  assert.equal(styles.length, 1);
  const coldScripts = scripts.filter((name) => !ON_DEMAND.includes(name));
  assert.equal(coldScripts.length >= 1 && coldScripts.length <= 3, true, `${coldScripts.length} scripts`);
  assert.equal(assets.length, styles.length + scripts.length,
    `only stylesheets and scripts: ${assets.join(', ')}`);
  assert.equal(1 + atOnce.length <= 5, true);
});

test('the page refers to its files under the build id and to nothing else', () => {
  const references = [...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => match[1]);
  const fetched = references.filter((reference) => !/^(#|data:)/.test(reference));
  assert.deepEqual([...new Set(fetched)].sort(), atOnce.map((name) => `/assets/%BUILD%/${name}`).sort());

  // The icon is inline, so the browser does not ask for /favicon.ico.
  assert.match(page, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.equal((page.match(/%CONFIG%/g) ?? []).length, 1);
  assert.match(page, /<meta name="cranium-config" content="%CONFIG%">/);
});

test('scripts import only each other, by relative path, and only app.js fetches a page script when it opens', () => {
  const reachable = new Set();
  const entry = /<script type="module" src="\/assets\/%BUILD%\/([a-z.]+)"><\/script>/.exec(page)[1];
  const visit = (name) => {
    if (reachable.has(name)) return;
    assert.equal(sources.has(name), true, `${name} is imported but is not in the site`);
    reachable.add(name);
    const source = code(sources.get(name));
    const fetched = [...source.matchAll(/\bimport\s*\(([^)]*)\)/g)].map((match) => match[1]);
    if (name === 'app.js') assert.deepEqual(fetched.sort(), ON_DEMAND.map((file) => `'./${file}'`));
    else assert.deepEqual(fetched, [], `${name} must not import on demand`);
    for (const file of name === 'app.js' ? ON_DEMAND : []) visit(file);
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
  // The one exception is a link for a person to follow: a commit on GitHub.
  const commitLinks = /'https:\/\/github\.com\/ese5180\/f26-t07-the-cranium\/commit\/'/g;
  for (const [name, text] of [...sources, ['index.html', page], [styles[0], css]]) {
    const others = name === 'history.js' ? text.replace(commitLinks, '') : text;
    assert.doesNotMatch(others.replace(namespaces, ''), /https?:\/\/[a-z0-9]/i, `${name} names another site`);
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
    ['--work', '--paper'],
    ['--good', '--paper'],
    ['--warn', '--paper'],
    ['--bad', '--paper'],
    ['--ink', '--work-wash'],
    ['--on-bar-live', '--bar-live'],
    ['--on-bar-good', '--bar-good'],
    ['--on-bar-bad', '--bar-bad'],
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

test('on the ink panel, lettering and marks hold up in both themes', () => {
  const light = new Map([...declared(':root'), ...declared('.on-ink')]);
  const dark = new Map([
    ...declared(':root'),
    ...declared(':root', '@media (prefers-color-scheme: dark)'),
    ...declared('.on-ink'),
    ...declared('.on-ink', '@media (prefers-color-scheme: dark)'),
  ]);
  const letters = ['--ink', '--ink-2', '--ink-3', '--accent', '--work', '--good', '--warn', '--bad'];
  const marks = ['--bar-live', '--bar-good', '--bar-warn', '--bar-bad', '--line-mark'];
  const washes = [
    ['--accent', '--accent-wash'], ['--work', '--work-wash'], ['--good', '--good-wash'],
    ['--warn', '--warn-wash'], ['--bad', '--bad-wash'],
  ];
  for (const [name, colours] of [['light', light], ['dark', dark]]) {
    for (const text of letters) {
      const ratio = contrast(colours.get(text), colours.get('--surface'));
      assert.equal(ratio >= 4.5, true, `${text} on the panel, ${name}: ${ratio.toFixed(2)}:1`);
    }
    for (const mark of marks) {
      const ratio = contrast(colours.get(mark), colours.get('--surface'));
      assert.equal(ratio >= 3, true, `${mark} on the panel, ${name}: ${ratio.toFixed(2)}:1`);
    }
    for (const [text, wash] of washes) {
      for (const lettering of [text, '--ink']) {
        const ratio = contrast(colours.get(lettering), colours.get(wash));
        assert.equal(ratio >= 4.5, true, `${lettering} on ${wash}, ${name}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
  // Nearly the colour of the page: in the dark theme the panel carries the heaviest rule on it.
  assert.equal(declared('.on-ink', '@media (prefers-color-scheme: dark)').get('box-shadow'), 'inset 0 3px 0 var(--ink)');
});

test('colour keeps to what it means', () => {
  // Only a confirmed update turns the line green; a step that is merely done stays ink.
  assert.equal(declared('.step.is-done .step-mark').get('background'), 'var(--ink)');
  assert.equal(declared('.steps.is-good .step.is-done .step-mark').get('background'), 'var(--bar-good)');
  // A decline is amber, and a failure red; where nothing went wrong there is neither.
  assert.equal(declared('.steps.is-warn').get('--stop-fill'), 'var(--bar-warn)');
  assert.equal(declared('.steps').get('--stop-fill'), 'var(--bar-bad)');
  assert.equal(declared('.step.is-stopped .step-mark').get('background'), 'var(--ink-3)');
  // The system at work is blue, and somebody's turn is rust.
  assert.equal(declared('.steps').get('--now-fill'), 'var(--bar-live)');
  assert.equal(declared('.steps.is-act').get('--now-fill'), 'var(--accent)');
  // Only the moment when somebody is needed pulses.
  const pulsing = rules.filter((rule) => /\bbeacon\b/.test(rule.values.get('animation') ?? ''));
  assert.deepEqual(pulsing.flatMap((rule) => rule.selectors), ['.steps.is-act .step.is-current .step-mark']);
});

test('a line through a version means that it was revoked, and nothing else', () => {
  const struck = rules.filter((rule) => /line-through/.test(rule.values.get('text-decoration') ?? ''));
  assert.equal(struck.length >= 1, true);
  for (const rule of struck) {
    for (const selector of rule.selectors) assert.match(selector, /\.is-revoked\b/, selector);
  }
});

test('type stays in the weights that system fonts have', () => {
  const weights = new Set(rules.map((rule) => rule.values.get('font-weight')).filter(Boolean));
  for (const weight of weights) assert.match(weight, /^(?:400|500|600|700)$/);
  for (const rule of rules) {
    const tracking = /^(-?[\d.]+)em$/.exec(rule.values.get('letter-spacing') ?? '');
    if (tracking) assert.equal(Number(tracking[1]) >= -0.03, true, rule.selectors.join());
  }
});

test('what a dialog says about a failed request does not scroll away with its body', () => {
  // The body takes the room that is left and scrolls. The message keeps its own height
  // between the body and the buttons, up to a share of the window.
  assert.equal(declared('.dialog-body').get('overflow-y'), 'auto');
  assert.equal(declared('.dialog-body').get('min-height'), '0');
  assert.equal(declared('.dialog-error').get('flex'), 'none');
  assert.match(declared('.dialog-error').get('max-height') ?? '', /^\d+vh$/);
  assert.equal(declared('.dialog-error').get('overflow-y'), 'auto');
});

test('a state that asks for somebody has a look of its own, and motion is never needed to read one', () => {
  assert.equal(rules.some((rule) => rule.selectors.includes('.execution.is-act .execution-state')), true);
  assert.equal(declared('.execution.is-act .execution-state').get('background'), 'var(--accent-wash)');
  // With reduced motion the bar that waits for the server is not left standing part full.
  const still = '@media (prefers-reduced-motion: reduce)';
  assert.equal(declared('.meter.is-busy .meter-fill', still).get('width'), '100%');
});

test('the steps of an update keep their places from one phase to the next', () => {
  // Seven equal columns. A current step is heavier, not wider, and the last one is not pinned to the edge.
  assert.equal(declared('.step').get('flex'), '1 1 0');
  assert.equal(rules.some((rule) => rule.selectors.includes('.step.is-current') && rule.values.has('flex-grow')), false);
  assert.equal(declared('.step').has('transition'), false);
  assert.equal(declared('.step:last-child').has('text-align'), false);
  assert.equal(rules.some((rule) => rule.selectors.includes('.step:last-child .step-mark')), false);
  // The rule for the step that cannot be told, in both layouts of the steps.
  assert.equal(declared('.step.is-unknown .step-mark').get('border-style'), 'dashed');
});

test('colours mean what they mean inside the upload panel too', () => {
  // Rust is not for links in a panel, and a stage that is merely finished is ink.
  assert.equal(declared('.drop-pick').get('color'), 'var(--ink)');
  assert.equal(declared('.upload-stage.is-done').get('--stage'), 'var(--ink)');
  assert.equal(declared('.upload-stage.is-good').get('--stage'), 'var(--bar-good)');
});

test('what grows with the text is measured in text, not in pixels', () => {
  assert.equal(declared('.flash-row').get('grid-template-columns'), '7rem minmax(0, 0.9fr) minmax(0, 1.5fr)');
  assert.equal(declared('.flash-row', '@container flash (max-width: 34rem)').get('grid-template-columns'), 'auto minmax(0, 1fr)');
  assert.equal(declared('.flash-row', '@container flash (max-width: 16rem)').get('grid-template-columns'), 'minmax(0, 1fr)');
  assert.match(declared('.device-grid', '@container page (min-width: 64rem)').get('--device-columns'), /^minmax\(14\.5rem, 1\.5fr\) minmax\(8\.5rem, 0\.7fr\)/);
  assert.equal(declared('.upload-stage-mark').get('width'), '1.625rem');
  assert.equal(declared('.wizard-number').get('width'), '1.375rem');
  // At large text the sections take more rows, and none is left out of sight in a strip.
  assert.equal(declared('.nav-list', '@media (max-width: 860px)').get('flex-wrap'), 'wrap');
  assert.equal(declared('.nav', '@media (max-width: 860px)').has('overflow-x'), false);
  // A compact list of steps hides its words from the eye and not from a screen reader.
  assert.equal(declared('.steps.is-compact .step-state').has('display'), false);
  assert.equal(declared('.steps.is-compact .step-state').get('clip-path'), 'inset(50%)');
});

test('a small button keeps its size next to text that could take the room', () => {
  assert.equal(declared('.btn.is-icon').get('flex'), 'none');
});

test('what the keyboard moves to stays in view and shows whole', () => {
  // The masthead stands at the top of the window from this width on.
  // In text, not in pixels: it takes more rows at large text.
  assert.equal(declared('html', '@media (min-width: 1141px)').get('scroll-padding-top'), '5rem');
  assert.equal(declared('.masthead-inner', '@media (min-width: 861px) and (max-width: 1140px)').get('flex-wrap'), 'wrap');
  // A dot list is clipped on the left only: a focus ring in it is not cut off on the other sides.
  assert.match(declared('.dotted').get('clip-path'), /^inset\(-\d+px -\d+px -\d+px 18px\)$/);
  assert.equal(declared('.nav-link').get('padding-inline'), '6px');
  assert.equal(declared('.nav-link').get('margin-inline'), '-6px');
});

test('at larger text the masthead wraps rather than laying one thing over another', () => {
  assert.equal(declared('.masthead-inner').get('flex-wrap'), 'wrap');
  assert.equal(declared('.account').get('margin-left'), 'auto');
});

test('what cannot be used is still readable, and looks the same on every kind of button', () => {
  const held = declared('.btn:disabled');
  assert.equal(held.get('color'), 'var(--ink-3)');
  assert.equal(held.get('background'), 'var(--well)');
  assert.equal(held.has('opacity'), false);
  assert.equal(rules.some((rule) => rule.selectors.includes('.btn[aria-disabled="true"]')), true);
  // After the looks that it has to win over, at the same specificity.
  assert.equal(css.indexOf('.btn.is-danger {') < css.indexOf('.btn:disabled'), true);
});

test('with forced colours the current section is still marked, and the steps still connect', () => {
  const forced = '@media (forced-colors: active)';
  assert.equal(declared('.nav-link', forced).get('border-color'), 'Canvas');
  assert.equal(declared('.nav-link[aria-current="page"]', forced).get('border-bottom-color'), 'Highlight');
  assert.equal(declared('.step::before', forced).get('background'), 'CanvasText');
  assert.equal(declared('.step.is-done .step-mark .icon', forced).get('color'), 'Canvas');
  // The icon on a filled mark goes with the fill, and what is drawn as a background stays there.
  assert.equal(declared('.step.is-current .step-mark .icon', forced).get('color'), 'HighlightText');
  assert.equal(declared('.step.is-on-return::after', forced).get('background'), 'CanvasText');
  assert.equal(declared('.station::before', forced).get('background'), 'CanvasText');
});

test('layouts that change with the width agree on where they change', () => {
  // The steps stand in a column up to where the rail takes over from the bar.
  assert.equal(declared('.steps', '@media (max-width: 800px)').get('grid-template-columns'), 'minmax(0, 1fr)');
  assert.equal(declared('.step.has-progress::before', '@media (min-width: 801px)').has('background'), true);
  // Next to the rail the bar is hidden from the eye, not from a screen reader.
  assert.equal(declared('.execution-state .meter', '@media (min-width: 801px)').has('display'), false);
  // The tools of a page take a row of their own on every page, or on none.
  assert.equal(declared('.page-tools', '@media (max-width: 1120px)').get('flex'), '1 1 100%');
  // A dialog hangs from the same line at every step, also on a phone.
  assert.equal(declared('.dialog', '@media (max-width: 720px)').has('margin-top'), false);
  // In a window that low the whole dialog scrolls.
  assert.equal(declared('.dialog', '@media (max-height: 480px)').get('overflow-y'), 'auto');
});

test('no file of the site contains an e-mail address', () => {
  for (const [name, text] of [...sources, ['index.html', page], [styles[0], css]]) {
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
  }
});

test('a finished update has no room kept for a next phase, and a headline is not hyphenated', () => {
  const stylesheet = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');
  const rule = (selector) => new RegExp(`${selector.replace(/[.:()]/g, '\\$&')}[^{}]*\\{[^}]*\\}`).exec(stylesheet)?.[0] ?? '';
  // Only while an update can still move on: live, waiting for a person, waiting for the board.
  const keeping = rule('.execution.is-live:not(.is-compact) .execution-state');
  assert.match(keeping, /\.execution\.is-act:not\(\.is-compact\) \.execution-state/);
  assert.match(keeping, /\.execution\.is-wait:not\(\.is-compact\) \.execution-state/);
  assert.match(keeping, /min-height: 9\.625rem/);
  assert.doesNotMatch(stylesheet, /(?:^|\n)\s*\.execution:not\(\.is-compact\) \.execution-state \{[^}]*min-height/);
  // At 360 px it broke as "in-stalled".
  assert.doesNotMatch(rule('.calm-title'), /hyphens/);
});

test('a percentage and the name of a slot stay in one piece', () => {
  const stylesheet = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');
  // In a narrow column of the overview it broke as "40" and "%" on two lines.
  assert.match(stylesheet, /(?:^|\n)\.status-value \{[^}]*white-space: nowrap/);
  // On a board's page at 360 px it broke as "Secondar" and "y slot".
  assert.match(stylesheet, /(?:^|\n)\.flash-name \{[^}]*white-space: nowrap/);
});

test('the place of an arrow is set for the row it belongs to', () => {
  const stylesheet = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');
  // Moved into the second column of a board's update history, it put the status into the
  // width of an arrow, one letter to a line.
  assert.doesNotMatch(stylesheet, /(?:^|\n)\s*\.row-chevron \{[^}]*grid-(?:column|row)/);
  assert.match(stylesheet, /\.deployment-row > \.row-chevron \{[^}]*grid-column: 2/);
  assert.match(stylesheet, /\.rows > \.history-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto 18px/);
});
