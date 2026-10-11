/**
 * The function that serves the web console (WebFn).
 *
 * The console is a handful of static files. They are read once, when the function
 * starts, into a table of exact request path -> response, and a request is answered
 * from that table or not at all. The request path is only ever a lookup key: it is
 * never decoded, normalised or joined to a directory, so nothing outside site/ can be
 * reached whatever the path says.
 *
 * Assets are served under /assets/<build id>/, where the build id is a hash of the
 * whole site, and may be cached for ever; any other build id is a 404. The page itself
 * is revalidated on every load. It carries the public sign-in settings in a <meta>
 * tag; nothing in them is secret.
 *
 * The query string is never read and never logged: after sign-in it carries the
 * authorization code.
 *
 * No dependencies: only node:crypto and node:fs.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const SITE = new URL('./site/', import.meta.url);
const BUILD_ID_LENGTH = 12;
const BUILD_MARK = '%BUILD%';
const CONFIG_MARK = '%CONFIG%';

const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_TYPES = new Map([
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
]);
const HTML = 'text/html; charset=utf-8';
const PLAIN = 'text/plain; charset=utf-8';

const CACHE_ASSET = 'public, max-age=31536000, immutable';
const CACHE_PAGE = 'no-cache';
const CACHE_NEVER = 'no-store';

// Lower case, as API Gateway reports it. Anything else is refused, not repaired.
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
// The login origin is written into the Content-Security-Policy header, where a space,
// comma or semicolon would start a new source, policy or directive.
const ORIGIN = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;

const LOGGED_PATH_LENGTH = 200;

/**
 * Read site/ into memory: index.html and the files directly inside assets/. Anything
 * else there (a subdirectory, a link, a file type the console does not use) stops the
 * function from starting, so it is noticed by the tests instead of being shipped.
 */
function loadSite(base) {
  const files = [{ name: 'index.html', bytes: readFileSync(new URL('index.html', base)) }];

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name !== 'index.html' && entry.name !== 'assets') {
      throw new Error(`Unexpected entry in site/: ${entry.name}`);
    }
  }

  const assetsDir = new URL('assets/', base);
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const type = ASSET_TYPES.get(entry.name.slice(entry.name.lastIndexOf('.') + 1));
    if (!entry.isFile() || !ASSET_NAME.test(entry.name) || !type) {
      throw new Error(`Unexpected entry in site/assets/: ${entry.name}`);
    }
    files.push({
      name: `assets/${entry.name}`,
      file: entry.name,
      type,
      bytes: readFileSync(new URL(entry.name, assetsDir)),
    });
  }

  // The build id covers every file name and every byte, each prefixed with its length
  // so that no two different sites feed the hash the same input.
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const hash = createHash('sha256');
  for (const { name, bytes } of files) {
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  const buildId = hash.digest('hex').slice(0, BUILD_ID_LENGTH);

  const assets = new Map();
  let page;
  for (const { name, file, type, bytes } of files) {
    if (name === 'index.html') {
      page = bytes.toString('utf8').replaceAll(BUILD_MARK, buildId).split(CONFIG_MARK);
    } else {
      assets.set(`/assets/${buildId}/${file}`, { type, body: bytes.toString('utf8') });
    }
  }
  if (page.length !== 2) {
    throw new Error(`index.html must contain ${CONFIG_MARK} exactly once`);
  }
  return { buildId, assets, pageHead: page[0], pageTail: page[1] };
}

const site = loadSite(SITE);

const ATTRIBUTE_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Make any text safe inside a double-quoted HTML attribute. */
function escapeAttribute(text) {
  return text.replace(/[&<>"']/g, (character) => ATTRIBUTE_ESCAPES[character]);
}

function requireText(name, value) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function securityHeaders(loginOrigin) {
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ${loginOrigin}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()',
  };
}

function writeLog(entry) {
  console.log(JSON.stringify(entry));
}

/**
 * Build a handler for API Gateway HTTP API events (payload format 2.0).
 *
 * @param {object} options
 * @param {string} options.clientId      app client id the console signs in with
 * @param {string} options.loginOrigin   origin of the managed login pages, for example
 *                                       https://<prefix>.auth.<region>.amazoncognito.com
 * @param {string} options.scope         OAuth scopes, space separated
 * @param {string} [options.redirectUri] the address the login pages send the browser
 *                                       back to. Left out, it is https://<the domain
 *                                       name of the request>/. Only the local preview
 *                                       sets it, to a loopback address.
 * @param {(entry: object) => void} [options.log]  receives one entry per request
 */
export function createWebHandler({ clientId, loginOrigin, scope, redirectUri, log = writeLog } = {}) {
  requireText('clientId', clientId);
  requireText('scope', scope);
  requireText('loginOrigin', loginOrigin);
  if (!ORIGIN.test(loginOrigin)) {
    throw new TypeError('loginOrigin must be an origin such as https://login.example');
  }
  if (redirectUri !== undefined) requireText('redirectUri', redirectUri);

  const headers = securityHeaders(loginOrigin);

  function respond(statusCode, type, cacheControl, body, extra) {
    return {
      statusCode,
      headers: { ...headers, 'content-type': type, 'cache-control': cacheControl, ...extra },
      body,
      isBase64Encoded: false,
    };
  }

  function page(event) {
    let returnTo = redirectUri;
    if (returnTo === undefined) {
      const host = event?.requestContext?.domainName;
      if (typeof host !== 'string' || !HOST.test(host)) {
        return respond(400, PLAIN, CACHE_NEVER, 'Bad request\n');
      }
      returnTo = `https://${host}/`;
    }
    const config = JSON.stringify({ clientId, loginOrigin, scope, redirectUri: returnTo });
    return respond(200, HTML, CACHE_PAGE, site.pageHead + escapeAttribute(config) + site.pageTail);
  }

  function answer(event) {
    if (event?.requestContext?.http?.method !== 'GET') {
      return respond(405, PLAIN, CACHE_NEVER, 'Method not allowed\n', { allow: 'GET' });
    }
    const path = event.rawPath;
    if (path === '/') return page(event);
    const asset = typeof path === 'string' ? site.assets.get(path) : undefined;
    if (asset) return respond(200, asset.type, CACHE_ASSET, asset.body);
    return respond(404, PLAIN, CACHE_NEVER, 'Not found\n');
  }

  return async function webHandler(event) {
    const response = answer(event);
    const context = event?.requestContext;
    log({
      requestId: typeof context?.requestId === 'string' ? context.requestId : null,
      method: typeof context?.http?.method === 'string' ? context.http.method : null,
      path: typeof event?.rawPath === 'string' ? event.rawPath.slice(0, LOGGED_PATH_LENGTH) : null,
      status: response.statusCode,
    });
    return response;
  };
}

function settingsFromEnvironment(env) {
  for (const name of ['USER_POOL_CLIENT_ID', 'LOGIN_DOMAIN', 'OAUTH_SCOPE']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  return {
    clientId: env.USER_POOL_CLIENT_ID,
    loginOrigin: `https://${env.LOGIN_DOMAIN}`,
    scope: env.OAUTH_SCOPE,
  };
}

let deployed;

/**
 * Lambda entry point. The settings come from the function's environment and both the
 * login origin and the redirect address are always https. The environment is read on
 * the first request, so that the preview and the tests can import this module without
 * one; the site itself was read when the module was loaded.
 */
export const handler = async (event) => {
  deployed ??= createWebHandler(settingsFromEnvironment(process.env));
  return deployed(event);
};
