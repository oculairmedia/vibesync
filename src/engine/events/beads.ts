/**
 * Bead status transition, payload `{ issueId, from, to }` (vibesync-p489).
 * The scheduler SUBSCRIBES to this; StatusChangePoller produces it from bd
 * status updates. A `to` of ready|in_progress|closed
 * requests an immediate (debounced) tick; any other status is ignored.
 */
export const BEADS_ISSUE_STATUS_CHANGED_EVENT = 'beads/issue.status_changed';
