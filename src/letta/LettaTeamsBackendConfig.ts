/**
 * LettaTeamsBackendConfig — single source of truth for the env that
 * pins our letta-teams stack to one Letta backend.
 *
 * Two independent layers read backend config:
 *
 *   1. letta-teams-sdk's agent-core reads `process.env.LETTA_BASE_URL`
 *      and `process.env.LETTA_API_KEY` at the moment its daemon spawns
 *      the `letta` CLI subprocess. The subprocess inherits env from
 *      the daemon's parent; mutating env *after* the daemon starts has
 *      no effect on already-running children.
 *
 *   2. Our LettaTeamsMemoryBlockSeeder uses `@letta-ai/letta-client`,
 *      which takes `{ baseUrl, token }` at construction time and uses
 *      Bearer auth on every REST call.
 *
 * If those two layers drift (one points at Letta Cloud, the other at
 * self-hosted), the `agentId` teams returns will not exist in the
 * database our seeder writes to and `seed()` will 404. Nothing in our
 * code currently enforces alignment. This class does.
 *
 * ## Foot-gun: ~/.lteams/
 *
 * letta-teams keeps a sidecar of teammate metadata (names → agentIds,
 * conversation targets) under `~/.lteams/`, **regardless of which
 * Letta backend is in use**. The store and the server can diverge:
 *
 *   - Wipe ~/.lteams/ → the next spawn with the same teammate name
 *     creates a SECOND agent on the server; the first is orphaned.
 *   - Restore ~/.lteams/ from a backup pointing at deleted/renamed
 *     agents → dispatches go to vanished targets.
 *
 * Detection + runbook is tracked in vibesync-6wn.10. Until that lands,
 * the operational rule is: **never wipe ~/.lteams/ without first
 * deleting the corresponding agents on the Letta server**.
 *
 * ## `LETTA_SEND_MESSAGES` is a no-op (vibesync-vkp)
 *
 * The env var `LETTA_SEND_MESSAGES` exists in `tests/setup.ts` history
 * as a perceived safety gate, but it is **not consulted anywhere** —
 * not in vibesync, not in letta-teams-sdk, not in `@letta-ai/letta-
 * client`. There is no dry-run mode for either the REST seeder path or
 * the teams `runtime.tasks.dispatch` path. If you need a dry-run guard,
 * one has to be built; do not rely on `LETTA_SEND_MESSAGES=false` to
 * stop outbound side effects.
 *
 * ## "Failed to validate." spam is informational (vibesync-vkp)
 *
 * `@letta-ai/letta-client` is Fern-generated and calls
 * `maybeSkipValidation` with `skipValidation: true` on every resource
 * response. When the Letta server returns a payload the bundled schema
 * does not recognise, the client emits `console.warn("Failed to
 * validate.\n  - <field>: <reason>")` and proceeds with the raw value.
 * The warning is harmless — it indicates server-side schema drift
 * relative to the pinned client, not a request failure. The teammate
 * dispatch we observed during the first Gastown molecule run
 * (vibesync-vkp) was producing this warning ~8× per reviewer step and
 * still completing successfully.
 *
 * To silence the spam at boot, set `LETTA_SILENCE_VALIDATION_SPAM=true`
 * and call `installLettaClientValidationFilter()` once during boot —
 * see LettaClientValidationFilter.ts. Default is "noisy" so we never
 * lose signal in incident triage.
 *
 * See vibesync-6wn.11.
 */

import { LettaClient } from '@letta-ai/letta-client';

import type { MemoryBlockSeeder, TeammateDeleter } from '../orchestration/runtime/index.js';
import { LettaTeamsMemoryBlockSeeder } from './LettaTeamsMemoryBlockSeeder.js';
import { LettaTeammateDeleter } from './LettaTeammateDeleter.js';

const DEFAULT_LETTA_BASE_URL = 'https://api.letta.com';

export interface LettaTeamsBackendOptions {
  /** Explicit base URL override. Defaults to env LETTA_BASE_URL. */
  readonly baseUrl?: string;
  /** Explicit API key / token override. Defaults to env LETTA_API_KEY → LETTA_PASSWORD. */
  readonly apiKey?: string;
  /** Optional CLI path override. Defaults to env LETTA_CLI_PATH. */
  readonly cliPath?: string;
  /** Source of env reads — test seam. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export class LettaTeamsBackendConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly cliPath: string | null;

  constructor(opts: LettaTeamsBackendOptions = {}) {
    const env = opts.env ?? process.env;
    const baseUrl =
      opts.baseUrl ?? (typeof env['LETTA_BASE_URL'] === 'string' && env['LETTA_BASE_URL'].length > 0
        ? (env['LETTA_BASE_URL'] as string)
        : DEFAULT_LETTA_BASE_URL);
    const apiKey =
      opts.apiKey ??
      (typeof env['LETTA_API_KEY'] === 'string' && env['LETTA_API_KEY'].length > 0
        ? (env['LETTA_API_KEY'] as string)
        : typeof env['LETTA_PASSWORD'] === 'string' && env['LETTA_PASSWORD'].length > 0
          ? (env['LETTA_PASSWORD'] as string)
          : '');
    if (!apiKey) {
      throw new Error(
        'LettaTeamsBackendConfig: no apiKey supplied and neither LETTA_API_KEY nor LETTA_PASSWORD is set in env',
      );
    }
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    const cliPath =
      opts.cliPath ?? (typeof env['LETTA_CLI_PATH'] === 'string' && env['LETTA_CLI_PATH'].length > 0
        ? (env['LETTA_CLI_PATH'] as string)
        : null);
    this.cliPath = cliPath;
  }

  /**
   * The env vars the letta-teams daemon (and the CLI subprocess it
   * spawns) needs to talk to the configured backend. Apply this to
   * `process.env` BEFORE calling `LettaTeamsProvider.ensureDaemonRunning()`.
   */
  daemonEnv(): Record<string, string> {
    const out: Record<string, string> = {
      LETTA_BASE_URL: this.baseUrl,
      LETTA_API_KEY: this.apiKey,
    };
    if (this.cliPath) out['LETTA_CLI_PATH'] = this.cliPath;
    return out;
  }

  /**
   * Apply `daemonEnv()` to a mutable env (default `process.env`) so a
   * subsequently-spawned letta-teams daemon inherits the right config.
   * Returns the env values that were set, for logging.
   */
  applyToProcessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const next = this.daemonEnv();
    for (const [k, v] of Object.entries(next)) {
      env[k] = v;
    }
    return next;
  }

  /**
   * Build a `LettaTeamsMemoryBlockSeeder` wired to a `LettaClient`
   * pointed at the same `(baseUrl, apiKey)` pair, so the seeder and
   * the teams CLI subprocess cannot drift onto different backends.
   */
  buildSeeder(): MemoryBlockSeeder {
    const client = new LettaClient({ baseUrl: this.baseUrl, token: this.apiKey });
    return new LettaTeamsMemoryBlockSeeder(client as never);
  }

  /**
   * Build a TeammateDeleter pointing at the same Letta backend
   * (vibesync-6zj). Wired in alongside the seeder at orchestration
   * boot so LettaTeamsProvider.stop() can actually free the spawned
   * agent after each formula step.
   *
   * apiURL on the deleter normalizes to include `/v1` — matching the
   * shape LettaToolService and friends already use.
   */
  buildDeleter(): TeammateDeleter {
    const apiURL = this.baseUrl.endsWith('/v1') ? this.baseUrl : `${this.baseUrl}/v1`;
    return new LettaTeammateDeleter({ apiURL, password: this.apiKey });
  }
}
