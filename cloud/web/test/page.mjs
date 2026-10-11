/**
 * Stand-ins for the browser, for the tests that run the console's own scripts.
 *
 * views.js writes to a document through a handful of calls: it creates elements and
 * text nodes, sets attributes and a few properties, and moves children about. This
 * file has just that much of a document, strict where a browser is strict (removing a
 * node from an element that does not hold it throws), and a way to load the scripts of
 * the site the way the browser loads them. app.test.mjs adds a window around it.
 *
 * Nothing here is a test; the file only has exports.
 */

import { readFileSync } from 'node:fs';

const ASSETS = new URL('../src/site/assets/', import.meta.url);

/**
 * The address of one of the site's scripts as a module that Node can import.
 *
 * The scripts are plain ".js" files with no package.json beside them, which Node only
 * takes for ES modules from 22.7 on. Importing the source through a data: URL works on
 * every Node 22. A module loaded that way cannot import by relative path, so each
 * import of another script is pointed at that script's own data: URL.
 *
 * @param {string} name      the file in site/assets
 * @param {object} [imports] file name -> address, for every script this one imports
 * @param {string} [mark]    makes the address differ, for a second copy of a module
 */
export function scriptAddress(name, imports = {}, mark = '') {
  let source = readFileSync(new URL(name, ASSETS), 'utf8');
  for (const [file, address] of Object.entries(imports)) {
    const specifier = `from './${file}'`;
    if (!source.includes(specifier)) throw new Error(`${name} does not import ${file}`);
    source = source.replaceAll(specifier, `from '${address}'`);
  }
  if (/from '\.\//.test(source)) throw new Error(`${name} imports a script it was not given an address for`);
  if (mark !== '') source += `\n// ${mark}\n`;
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

export const CORE = scriptAddress('core.js');
export const VIEWS = scriptAddress('views.js', { 'core.js': CORE });

// The document.

class Node {
  constructor() {
    this.parentNode = null;
  }

  get parentElement() {
    return this.parentNode;
  }

  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get isConnected() {
    return this.parentNode !== null && this.parentNode.isConnected;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }
}

class Text extends Node {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.textContent = text;
  }
}

class Element extends Node {
  constructor(tag, namespace, document) {
    super();
    this.nodeType = 1;
    this.localName = tag;
    this.tagName = namespace === null ? tag.toUpperCase() : tag;
    this.namespaceURI = namespace;
    this.ownerDocument = document;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.custom = new Map();
    this.style = {
      setProperty: (name, value) => this.custom.set(name, value),
      removeProperty: (name) => this.custom.delete(name),
    };
    // The properties the console sets directly, as a new element has them.
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.indeterminate = false;
    this.scrollTop = 0;
    this.open = false;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(text) {
    this.replaceChildren(new Text(String(text)));
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(names) {
    this.setAttribute('class', names);
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  #adopt(child) {
    if (!(child instanceof Node)) throw new TypeError('Only a node can be put into an element');
    for (let node = this; node !== null; node = node.parentNode) {
      if (node === child) throw new Error('HierarchyRequestError: a node cannot hold itself');
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
  }

  appendChild(child) {
    this.#adopt(child);
    this.childNodes.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(typeof child === 'string' ? new Text(child) : child);
  }

  insertBefore(child, before) {
    if (before === null) return this.appendChild(child);
    if (before.parentNode !== this) {
      throw new Error('NotFoundError: the node to insert before is not a child');
    }
    if (child === before) return child;
    this.#adopt(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index === -1) throw new Error('NotFoundError: the node to remove is not a child');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...children) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...children);
  }

  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  /** Call the listeners of this element. Events do not travel up the tree here. */
  dispatchEvent(event) {
    const sent = { target: this, defaultPrevented: false, ...event, currentTarget: this };
    sent.preventDefault = () => {
      sent.defaultPrevented = true;
    };
    for (const listener of [...this.listeners.get(sent.type) ?? []]) listener(sent);
    return sent;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  // What a <dialog> does, as far as the console uses it.

  showModal() {
    if (!this.isConnected) throw new Error('InvalidStateError: the dialog is not in the document');
    if (this.open) throw new Error('InvalidStateError: the dialog is open already');
    this.open = true;
    const first = descendants(this).find((el) => el.hasAttribute('autofocus') && !el.disabled);
    (first ?? this).focus();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent({ type: 'close' });
  }
}

/**
 * A document with a <head>-less body, enough for render() and for the page frame.
 * `ids` are elements that the page has from the start, by id.
 */
export function createDocument(ids = []) {
  const document = {
    activeElement: null,
    visibilityState: 'visible',
    title: '',
    listeners: new Map(),
    createElement: (tag) => new Element(tag, null, document),
    createElementNS: (namespace, tag) => new Element(tag, namespace, document),
    createTextNode: (text) => new Text(String(text)),
    getElementById: (id) => descendants(document.body).find((el) => el.id === id) ?? null,
    addEventListener(type, listener) {
      if (!document.listeners.has(type)) document.listeners.set(type, new Set());
      document.listeners.get(type).add(listener);
    },
    dispatchEvent(event) {
      for (const listener of [...document.listeners.get(event.type) ?? []]) listener(event);
    },
  };
  document.body = new Element('body', null, document);
  // The body is the root of the document: connected by definition.
  Object.defineProperty(document.body, 'isConnected', { value: true });
  for (const id of ids) {
    const el = document.createElement('div');
    el.setAttribute('id', id);
    document.body.appendChild(el);
  }
  return document;
}

// Looking at what was drawn.

/** Every element below `root`, in document order. */
export function descendants(root) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

const classesOf = (el) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/**
 * The elements below `root` that match a simple selector: "tag", ".class",
 * "tag.class" or "tag.class.other".
 */
export function all(root, selector) {
  const [tag, ...classes] = selector.split('.');
  return descendants(root).filter((el) =>
    (tag === '' || el.localName === tag) && classes.every((name) => classesOf(el).includes(name)));
}

// Elements that the stylesheet sets apart from what is next to them: blocks, and the
// boxes that stand in a row with a gap between them.
const SET_APART = new Set([
  'article', 'button', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'footer', 'form', 'h1', 'h2',
  'header', 'label', 'legend', 'li', 'ol', 'p', 'section', 'summary', 'textarea', 'ul',
]);
const BOXES = ['badge', 'btn', 'tag', 'fact-note'];

function reads(node) {
  if (node.nodeType === 3) return node.textContent;
  const text = node.childNodes.map(reads).join('');
  const apart = SET_APART.has(node.localName) || classesOf(node).some((name) => BOXES.includes(name)) ||
    // The facts of a "dotted" run stand side by side with a dot between them.
    (node.parentNode !== null && classesOf(node.parentNode).includes('dotted'));
  return apart ? ` ${text} ` : text;
}

/**
 * The text of a node as a reader meets it: what is set apart on the page is set apart
 * by a space here, and runs of white space are one space.
 */
export function textOf(node) {
  return reads(node).replace(/\s+/g, ' ').trim();
}

/** The elements matching `selector` whose text contains `words`. */
export function withText(root, selector, words) {
  return all(root, selector).filter((el) => textOf(el).includes(words));
}

/** The one element matching `selector` whose text contains `words`; anything else fails. */
export function one(root, selector, words = '') {
  const found = withText(root, selector, words);
  if (found.length !== 1) {
    throw new Error(`Expected one ${selector} with "${words}", found ${found.length}`);
  }
  return found[0];
}

/** What the user can press: the labels of the buttons and of the links drawn as buttons. */
export function controls(root) {
  return descendants(root)
    .filter((el) => el.localName === 'button' || (el.localName === 'a' && classesOf(el).includes('btn')))
    .map((el) => el.getAttribute('aria-label') ?? textOf(el));
}

/**
 * Click an element, with what a browser does next: a submit button submits its form,
 * and a checkbox or radio button reports a change.
 */
export function click(el) {
  if (el.disabled) throw new Error(`"${textOf(el)}" is disabled and cannot be clicked`);
  const event = el.dispatchEvent({ type: 'click' });
  if (event.defaultPrevented) return event;
  const type = el.getAttribute('type');
  if (el.localName === 'button' && type === 'submit') {
    for (let node = el.parentNode; node !== null; node = node.parentNode) {
      if (node.localName === 'form') {
        node.dispatchEvent({ type: 'submit' });
        break;
      }
    }
  } else if (el.localName === 'input' && (type === 'checkbox' || type === 'radio')) {
    el.dispatchEvent({ type: 'change' });
  }
  return event;
}
