#!/usr/bin/env node
/**
 * Compare the activity log with the digests in the function log. Read only, and not part
 * of the deployed function.
 *
 * Each stored entry leaves a line with its digest in the API function's log, which the
 * function's role cannot change. If an entry was rewritten afterwards, or deleted, this
 * finds it. See lib/audit.mjs for what that does and does not show. The log group keeps
 * its lines for 90 days and the table has no expiry, so older entries have no line left.
 *
 *   aws dynamodb query --table-name <AuditTableName> \
 *     --key-condition-expression 'pk = :p' \
 *     --expression-attribute-values '{":p":{"S":"AUD"}}' > audit.json
 *   aws logs filter-log-events --log-group-name <the API function's log group> \
 *     --filter-pattern '"audit_entry"' > digests.json
 *   node cloud/api/verify-audit.mjs audit.json digests.json
 *
 * Prints only request ids, never an entry. The exit status is 1 if an entry was changed,
 * is missing or should have a line and has none, and 2 if the files could not be read.
 *
 * A request logs one digest, so two different digests for one request id count as a
 * change: otherwise a rewrite with a second line next to it would pass. An entry with no
 * line is no alarm if it is older than the first line in the file, because the log may
 * have let its line go, or digests may not have been logged yet. A younger one should
 * have a line. A line can take a moment to reach the log, so look at one stored in the
 * last minutes again before concluding anything.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { auditDigest } from './src/lib/audit.mjs';

/** A value in DynamoDB's JSON form as plain data. */
function plain(attribute) {
  if (typeof attribute?.S === 'string') return attribute.S;
  if (typeof attribute?.N === 'string') return Number(attribute.N);
  if (typeof attribute?.BOOL === 'boolean') return attribute.BOOL;
  if (attribute?.NULL === true) return null;
  if (Array.isArray(attribute?.L)) return attribute.L.map(plain);
  if (attribute?.M !== undefined) return plainItem(attribute.M);
  throw new TypeError('This table holds a value of a kind the console never stores');
}

function plainItem(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, plain(value)]));
}

/** The digest line in one message of the log, or null. Lambda puts a prefix before the JSON. */
function digestLine(message) {
  const start = typeof message === 'string' ? message.indexOf('{') : -1;
  if (start === -1) return null;
  try {
    const line = JSON.parse(message.slice(start));
    return line?.event === 'audit_entry' && typeof line.requestId === 'string' && typeof line.digest === 'string'
      ? line
      : null;
  } catch {
    return null;
  }
}

/** The time in a sort key, in epoch milliseconds, or NaN. */
function storedAt(item) {
  return Date.parse(String(item.sk ?? '').split('#')[0]);
}

/**
 * @param {object[]} items   entries of the table, in DynamoDB's JSON form
 * @param {string[]} messages  messages of the function log
 * @param {object} [options]
 * @param {number|null} [options.logStart]  when the first digest line in the log was written,
 *   in epoch milliseconds. Without it, no entry can be told to be younger than the log.
 * @returns {{verified: string[], changed: string[], missing: string[], noLine: string[],
 *   unlogged: string[]}} request ids: entries that match their line; entries that do not,
 *   or that have several different lines; lines without an entry; entries without a line
 *   that are older than the log; and entries without a line that are not
 */
export function compareAudit(items, messages, { logStart = null } = {}) {
  const lines = new Map();
  for (const message of messages) {
    const line = digestLine(message);
    if (line === null) continue;
    if (!lines.has(line.requestId)) lines.set(line.requestId, new Set());
    lines.get(line.requestId).add(line.digest);
  }
  const result = { verified: [], changed: [], missing: [], noLine: [], unlogged: [] };
  for (const raw of items) {
    const item = plainItem(raw);
    const digests = lines.get(item.requestId);
    if (digests === undefined) {
      (logStart !== null && storedAt(item) >= logStart ? result.unlogged : result.noLine).push(item.requestId);
    } else if (digests.size === 1 && digests.has(auditDigest(item))) {
      result.verified.push(item.requestId);
    } else {
      result.changed.push(item.requestId);
    }
    lines.delete(item.requestId);
  }
  result.missing.push(...lines.keys());
  return result;
}

/** When the earliest digest line was written, in epoch milliseconds, or null. */
function firstLine(events) {
  const times = events
    .filter((event) => digestLine(event.message) !== null && Number.isFinite(event.timestamp))
    .map((event) => event.timestamp);
  return times.length > 0 ? Math.min(...times) : null;
}

function main([auditFile, logFile]) {
  if (auditFile === undefined || logFile === undefined) {
    process.stderr.write('usage: node verify-audit.mjs <aws dynamodb query output> <aws logs filter-log-events output>\n');
    return 2;
  }
  let result;
  try {
    const items = JSON.parse(readFileSync(auditFile, 'utf8')).Items ?? [];
    const events = JSON.parse(readFileSync(logFile, 'utf8')).events ?? [];
    result = compareAudit(items, events.map((event) => event.message), { logStart: firstLine(events) });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }
  for (const id of result.changed) {
    process.stdout.write(`CHANGED  ${id}: the entry does not match its digest, or it has several\n`);
  }
  for (const id of result.missing) process.stdout.write(`MISSING  ${id}: the log has a digest, the table no entry\n`);
  for (const id of result.unlogged) {
    process.stdout.write(`UNLOGGED ${id}: the entry is younger than the first line in the log and has none\n`);
  }
  process.stdout.write(`${result.verified.length} entries match their digest, ${result.changed.length} do not, ` +
    `${result.missing.length} are missing, ${result.unlogged.length} should have a line and have none. ` +
    `${result.noLine.length} are older than the log, and cannot be compared.\n`);
  return result.changed.length + result.missing.length + result.unlogged.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
