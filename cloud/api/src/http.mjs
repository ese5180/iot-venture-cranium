/**
 * Responses and errors of the console API.
 *
 * Every response is JSON and is never cached. An error leaves the API as
 *
 *   { "error": { "code": "snake_case", "message": "text for a person", "requestId": "..." } }
 *
 * and a 500 says nothing about what went wrong inside: details go to the log only.
 */

const HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

// Bodies other than a firmware upload are a few short fields.
export const SMALL_BODY_LIMIT = 16384;

/** An error with the status, code and message the caller is to see. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (code, message) => new HttpError(400, code, message);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in to use the console.');
export const forbidden = (code, message) => new HttpError(403, code, message);
export const notFound = (code, message) => new HttpError(404, code, message);
export const conflict = (code, message, details) => new HttpError(409, code, message, details);
export const unprocessable = (code, message) => new HttpError(422, code, message);

/** A response in the shape API Gateway expects for payload format 2.0. */
export function json(status, body) {
  return {
    statusCode: status,
    headers: { ...HEADERS },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/** The error code a caller sees for anything that was thrown. */
export function errorCode(error) {
  if (error instanceof HttpError) return error.code;
  // The adapter marks throttling by AWS; the browser retries those requests.
  if (error !== null && typeof error === 'object' && error.code === 'throttled') return 'throttled';
  return 'internal_error';
}

/**
 * Turn anything that was thrown into a response. Returns the response and, for
 * failures the caller did not cause, what to write to the log.
 */
export function errorResponse(error, requestId) {
  if (error instanceof HttpError) {
    const body = { code: error.code, message: error.message, requestId };
    if (error.details !== undefined) body.details = error.details;
    return { response: json(error.status, { error: body }), internal: null };
  }
  if (errorCode(error) === 'throttled') {
    return {
      response: json(429, {
        error: {
          code: 'throttled',
          message: 'AWS is limiting requests right now. Try again in a moment.',
          requestId,
        },
      }),
      internal: describeError(error),
    };
  }
  return {
    response: json(500, {
      error: {
        code: 'internal_error',
        message: 'Something went wrong on the server. Quote the request id when you report this.',
        requestId,
      },
    }),
    internal: describeError(error),
  };
}

/** What the log records about an unexpected failure: never a body, token or URL. */
export function describeError(error) {
  if (error === null || typeof error !== 'object') return { message: String(error).slice(0, 300) };
  const described = {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: String(error.message ?? '').slice(0, 300),
  };
  if (typeof error.operation === 'string') described.operation = error.operation;
  if (typeof error.code === 'string') described.code = error.code;
  if (typeof error.stack === 'string') described.stack = error.stack.split('\n').slice(0, 6).join('\n');
  return described;
}

/**
 * Read a request body that must be a JSON object. The size is checked before the
 * text is parsed. API Gateway sets isBase64Encoded when it passes the body encoded.
 */
export function readJsonObject(event, maxChars) {
  let text = event?.body;
  if (text === undefined || text === null) text = '';
  if (typeof text !== 'string') {
    throw badRequest('invalid_body', 'The request body must be a JSON object.');
  }
  if (event.isBase64Encoded === true) {
    // A character is at most three bytes of UTF-8, and base64 makes four characters
    // of every three bytes: a longer text cannot hold an acceptable body.
    if (text.length > 4 * maxChars + 4) throw tooLarge(maxChars);
    text = Buffer.from(text, 'base64').toString('utf8');
  }
  if (text.length > maxChars) throw tooLarge(maxChars);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest('invalid_json', 'The request body is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_body', 'The request body must be a JSON object.');
  }
  return value;
}

function tooLarge(maxChars) {
  return new HttpError(413, 'payload_too_large',
    `The request is too large: at most ${maxChars} characters are accepted.`);
}

/** The value of a field the caller sent, or undefined. Inherited names never count. */
export function field(body, name) {
  return Object.hasOwn(body, name) ? body[name] : undefined;
}
