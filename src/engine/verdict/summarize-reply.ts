const TRUNCATION_MARKER = '[... reply truncated ...]';
const CHECK_NAME = /\b(?:typecheck|tsc|type-check|test|vitest|suite|build|mutation|boot)\b/i;
const NOT_RUN = /\b(?:blocked|could not|cannot|not run|did not run|skipped|unverified|not rerun|missing)\b/i;

/** Bound reply text used in verdict reasons without losing unrun-check details. */
export function summarizeReplyForReason(reply: string, maxChars = 4000): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (reply.length <= limit) return reply;
  if (limit === 0) return '';

  const lines = reply.split(/(?<=\n)/);
  const isCheckLine = (line: string) => CHECK_NAME.test(line) && NOT_RUN.test(line);
  const marker = `${TRUNCATION_MARKER}\n`;
  // The marker is useful when it fits; for tiny limits its prefix is enough to
  // signal truncation while ensuring the result always stays within the cap.
  const truncation = marker.slice(0, limit);
  const budget = Math.max(0, limit - truncation.length);
  const selectedChecks = new Set<number>();
  let used = 0;

  for (const [lineIndex, line] of lines.entries()) {
    if (!isCheckLine(line)) continue;
    if (used + line.length > budget) continue;
    selectedChecks.add(lineIndex);
    used += line.length;
  }

  const opening: boolean[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (isCheckLine(line)) continue;
    if (used + line.length > budget) break;
    opening[lineIndex] = true;
    used += line.length;
  }

  const output: string[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (isCheckLine(line)) {
      if (selectedChecks.has(lineIndex)) output.push(line);
    } else if (opening[lineIndex]) {
      output.push(line);
    }
  }

  let body = output.join('');
  let suffix = truncation;
  if (body.length > 0 && !body.endsWith('\n') && !suffix.startsWith('\n')) {
    // Keep the truncation marker on its own line without exceeding the cap.
    if (body.length + suffix.length < limit) suffix = `\n${suffix}`;
    else body = body.slice(0, Math.max(0, body.length - 1));
  }
  return `${body}${suffix}`.slice(0, limit);
}
