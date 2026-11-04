export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms: ${operation}`)), timeoutMs),
    ),
  ]);
}

export async function processBatch<T>(
  items: T[],
  batchSize: number,
  processFunction: (item: T, index: number, array: T[]) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(processFunction));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Strip inline credentials from an HTTP(S) URL.
 *
 * Rewrites `https://<creds>@host/path` → `https://host/path` and the http variant.
 * Preserves the rest of the URL (host, port, path, query, fragment) verbatim.
 * SSH-style remotes (`git@github.com:owner/repo.git`) carry no inline credential
 * and are returned unchanged.
 *
 * Used as a defense-in-depth filter on any field that may contain a git remote
 * URL, API endpoint, or other URL that could have userinfo inlined. Apply both
 * at ingest (so storage stops carrying credentials) and at response
 * serialization (so a future ingest regression cannot leak to the wire).
 *
 * @see vibesync-6kg
 */
export function stripUrlCredentials<T extends string | null | undefined>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  // Match scheme://userinfo@ and drop the userinfo segment.
  // userinfo is everything between `://` and the next `@`, which by RFC 3986
  // cannot contain `@`, `/`, `?`, or `#`.
  return value.replace(/^(https?:\/\/)[^@/?#\s]+@/i, '$1') as T;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
