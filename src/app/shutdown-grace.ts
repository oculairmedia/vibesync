export function parseShutdownGraceMs(raw: string | undefined, warn: (variable: string, value: string) => void): number {
  if (raw === undefined) return 20000;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  warn('VIBESYNC_SHUTDOWN_GRACE_MS', raw);
  return 20000;
}
