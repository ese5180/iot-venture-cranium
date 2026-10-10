/**
 * The activity log: GET /api/audit, and the one place that writes entries.
 *
 * Entries are written by the request pipeline in app.mjs, one per request that tried
 * to change something. They are read newest first, a page at a time; the cursor of a
 * page is opaque to the browser and checked when it comes back.
 */

import { badRequest, describeError, field } from '../http.mjs';
import { auditItem, decodeCursor, encodeCursor, entryFromItem } from '../lib/audit.mjs';
import { requirePageSize } from '../lib/validate.mjs';

export function createAuditHandlers({ aws, log }) {
  return {
    /**
     * Store the entry for one request. Returns false if it could not be stored; the
     * failure is logged here. Never throws.
     */
    async record(entry) {
      try {
        // The key is the time and the request id, and entries are never overwritten.
        // A key that is taken means this entry is not in the log.
        const stored = await aws.putAudit(auditItem(entry));
        if (stored.ok) return true;
        log({
          level: 'error', event: 'audit_write_failed', requestId: entry.requestId, action: entry.action,
          outcome: entry.outcome, error: { message: 'an entry with this time and request id exists' },
        });
        return false;
      } catch (error) {
        log({
          level: 'error', event: 'audit_write_failed', requestId: entry.requestId, action: entry.action,
          outcome: entry.outcome, error: describeError(error),
        });
        return false;
      }
    },

    async list({ query }) {
      const limit = requirePageSize(field(query, 'limit'));
      const cursor = field(query, 'before');
      let before = null;
      if (cursor !== undefined) {
        before = decodeCursor(cursor);
        if (before === null) throw badRequest('invalid_cursor', '"before" is not a cursor from this log.');
      }
      // One more than the page, to know whether another page follows.
      const items = await aws.queryAudit({ before, limit: limit + 1 });
      const page = items.slice(0, limit);
      const last = page[page.length - 1];
      return {
        body: {
          entries: page.map(entryFromItem).filter((entry) => entry !== null),
          next: items.length > limit && typeof last?.sk === 'string' ? encodeCursor(last.sk) : null,
        },
      };
    },
  };
}
