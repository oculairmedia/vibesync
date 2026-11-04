/**
 * Structured "blocked" outcome for a formula step (vibesync-zvcm).
 *
 * A step used to count as successful whenever its turn ended with any text, so
 * a mayor that replied "Blocked before dispatch: ..." still let the coder,
 * reviewer and tester run (mol-mol-1wb2yks7zqjc). Every step's prompt now ends
 * with an instruction to finish a blocked reply with one exact line; the
 * dispatcher parses ONLY that final line, never free text, and treats it as a
 * terminal failure, so no dependent step starts.
 */

/** Exact prefix of the final line a blocked agent writes. */
export const BLOCKED_MARKER = 'STEP OUTCOME: BLOCKED';

/** Appended to every rendered step prompt. Kept short; the marker is the contract. */
export const STEP_OUTCOME_INSTRUCTIONS = [
  '',
  '---',
  'If you cannot complete this step (missing input, unsafe state, unclear request,',
  'or anything that should stop the steps after you), say why, then end your reply',
  `with exactly one final line: ${BLOCKED_MARKER} - <one-line reason>`,
  'Do not write that line if you completed the step.',
].join('\n');

/**
 * The blocker reason when `text` ends with the marker line, else null. Only the
 * last non-empty line counts, so quoting the marker mid-reply never blocks.
 * Accepts `-`, `:` or an em dash after the marker; the reason may be empty.
 */
export function parseBlockedOutcome(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last || !last.toUpperCase().startsWith(BLOCKED_MARKER)) return null;
  const reason = last.slice(BLOCKED_MARKER.length).replace(/^[\s:\-\u2013\u2014]+/, '').trim();
  return reason.length > 0 ? reason : 'no reason given';
}
