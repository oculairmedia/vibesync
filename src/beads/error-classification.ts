export type BeadsFailureReason =
  | 'dolt_unreachable'
  | 'db_not_found'
  | 'no_beads_db'
  | 'dolt_not_running';

const BEADS_FAILURE_PATTERNS: ReadonlyArray<{
  readonly pattern: string;
  readonly reason: BeadsFailureReason;
}> = [
  { pattern: 'connection refused', reason: 'dolt_unreachable' },
  { pattern: 'econnrefused', reason: 'dolt_unreachable' },
  { pattern: 'database not found', reason: 'db_not_found' },
  { pattern: 'database does not exist', reason: 'db_not_found' },
  { pattern: 'no such database', reason: 'db_not_found' },
  { pattern: 'failed to connect to dolt', reason: 'dolt_unreachable' },
  { pattern: 'dolt server not running', reason: 'dolt_not_running' },
  { pattern: 'no beads database', reason: 'no_beads_db' },
  { pattern: '.beads directory not found', reason: 'no_beads_db' },
  { pattern: 'beads_dir does not exist', reason: 'no_beads_db' },
];

export function classifyBeadsFailure(errorMsg: string): BeadsFailureReason | null {
  const lowerMsg = errorMsg.toLowerCase();
  return BEADS_FAILURE_PATTERNS.find(({ pattern }) => lowerMsg.includes(pattern))?.reason ?? null;
}
