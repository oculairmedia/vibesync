export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
