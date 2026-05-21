/**
 * LettaTeammateDeleter — concrete TeammateDeleter backed by Letta's
 * REST API (vibesync-6zj).
 *
 * Closes the leak that letta-teams-sdk leaves behind: the SDK's
 * `runtime.teammates.remove(name)` only unlinks the daemon's local
 * teammate JSON file — it does NOT call DELETE on the underlying Letta
 * agent. Without this deleter, every formula run leaks one Letta agent
 * per role.
 *
 * Lives in src/letta/ on purpose: the orchestration plane defines the
 * TeammateDeleter interface but never imports the Letta client; this
 * file is the one place we cross that boundary. Wire one at
 * application startup and pass it into LettaTeamsProvider via
 * `LettaTeamsProviderOptions.teammateDeleter`.
 *
 * Idempotency contract (per TeammateDeleter): delete(agentId) on an
 * agent that's already gone is a no-op — HTTP 404 is treated as
 * success. Other failures throw so the caller can log them.
 */

import { fetchWithPool } from '../http';
import type { TeammateDeleter } from '../orchestration/runtime/index.js';

export interface LettaTeammateDeleterOptions {
  /** Base URL (with /v1 already on it, e.g. http://localhost:8289/v1). */
  readonly apiURL: string;
  /** Bearer token. */
  readonly password: string;
  /**
   * Hard timeout for the DELETE request. Default 5_000 ms. Bounded so
   * that the dispatcher's finally-block can't be stuck waiting on a
   * dead Letta when stopping a teammate. The surfaced AbortError is
   * thrown like any other failure — the caller (LettaTeamsProvider) logs
   * and continues; the agent stays leaked until something else cleans
   * it up.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class LettaTeammateDeleter implements TeammateDeleter {
  private readonly apiURL: string;
  private readonly password: string;
  private readonly timeoutMs: number;

  constructor(opts: LettaTeammateDeleterOptions) {
    this.apiURL = opts.apiURL;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async delete(agentId: string): Promise<void> {
    const url = `${this.apiURL}/agents/${agentId}`;
    const response = await fetchWithPool(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.password}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    } as RequestInit);
    if (response.status === 404) {
      // Already gone — idempotent success. Tests rely on this.
      return;
    }
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch { /* ignore */ }
      throw new Error(`DELETE ${url} → HTTP ${response.status}: ${body}`);
    }
  }
}
