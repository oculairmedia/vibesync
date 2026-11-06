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
  const truncation = limit >= marker.length ? marker : marker.slice(0, limit);
  const selectedChecks = new Set<number>();
  let checkLength = 0;

  for (const [lineIndex, line] of lines.entries()) {
    if (!isCheckLine(line)) continue;
    const nextLength = checkLength + line.length;
    const separatorLength = nextLength > 0 && !line.endsWith('\n') ? 1 : 0;
    // Keep a full check line, its separating newline, and at least the marker.
    if (nextLength + TRUNCATION_MARKER.length + separatorLength > limit) continue;
    selectedChecks.add(lineIndex);
    checkLength = nextLength;
  }

  const opening: boolean[] = [];
  let used = checkLength;
  for (const [lineIndex, line] of lines.entries()) {
    if (isCheckLine(line)) continue;
    const nextLength = used + line.length;
    const separatorLength = nextLength > 0 && !line.endsWith('\n') ? 1 : 0;
    if (nextLength + truncation.length + separatorLength > limit) break;
    opening[lineIndex] = true;
    used = nextLength;
  }

  const output: string[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (isCheckLine(line)) {
      if (selectedChecks.has(lineIndex)) output.push(line);
    } else if (opening[lineIndex]) {
      output.push(line);
    }
  }

  const body = output.join('');
  const separator = body.length > 0 && !body.endsWith('\n') && !truncation.startsWith('\n') ? '\n' : '';
  let renderedMarker = truncation;
  let renderedSeparator = separator;
  // At an exact budget, retain the marker and check line but omit its final newline.
  if (`${body}${renderedSeparator}${renderedMarker}`.length > limit && renderedMarker.endsWith('\n')) {
    renderedMarker = renderedMarker.slice(0, -1);
  }
  return `${body}${renderedSeparator}${renderedMarker}`;
}
