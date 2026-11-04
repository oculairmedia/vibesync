/**
 * Optional console.warn filter that drops the "Failed to validate."
 * spam emitted by `@letta-ai/letta-client`'s `maybeSkipValidation`.
 *
 * Background (vibesync-vkp): the bundled letta-client is Fern-generated
 * and calls every response schema with `skipValidation: true`. When the
 * Letta server returns a payload field the client doesn't recognise
 * (server moves faster than the pinned client), it logs:
 *
 *     console.warn("Failed to validate.\n  - <path>: <message>");
 *
 * and returns the raw value as-if-validated. The call still succeeds.
 *
 * The warning is informational. During the first Gastown molecule run
 * we saw 8+ of these per reviewer step on a successful dispatch. Useful
 * during integration debugging, noise during normal operation.
 *
 * This module is opt-in (default is noisy — incident triage benefits
 * from the raw output). Call `installLettaClientValidationFilter()`
 * once during boot when `process.env.LETTA_SILENCE_VALIDATION_SPAM` is
 * truthy. It wraps `console.warn` such that any line starting with
 * "Failed to validate." (plus its indented continuation lines) is
 * dropped silently. Other warnings are passed through unchanged.
 *
 * Trade-off: a multi-line warn whose FIRST line is "Failed to
 * validate." has its continuation lines suppressed too. This is the
 * one we want to filter — fern emits the field path on subsequent
 * lines joined with "\n". Single-arg `console.warn(string)` only.
 */

const FAILED_TO_VALIDATE_PREFIX = 'Failed to validate.';

/**
 * Minimal shape of a console we're willing to wrap. Used so callers
 * can inject a test double without needing the full `Console`
 * interface.
 */
export interface WarnTarget {
  warn: (...args: unknown[]) => void;
}

export interface ValidationFilterDeps {
  /** Source for the toggle env value. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** The console object to wrap. Defaults to globalThis.console. */
  readonly console?: WarnTarget;
}

let installed = false;
let originalWarn: WarnTarget['warn'] | null = null;

function shouldDrop(args: readonly unknown[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  return typeof first === 'string' && first.startsWith(FAILED_TO_VALIDATE_PREFIX);
}

/**
 * Install the filter if `LETTA_SILENCE_VALIDATION_SPAM` is truthy.
 * Idempotent — repeated calls have no effect after the first install.
 * Returns `true` when the filter is now active, `false` when the env
 * gate is unset or already installed.
 */
export function installLettaClientValidationFilter(deps: ValidationFilterDeps = {}): boolean {
  if (installed) return true;
  const env = deps.env ?? process.env;
  const flag = env['LETTA_SILENCE_VALIDATION_SPAM'];
  if (!flag || flag === 'false' || flag === '0') return false;

  const target = (deps.console ?? console) as WarnTarget;
  const captured = target.warn;
  originalWarn = captured;
  target.warn = (...args: unknown[]) => {
    if (shouldDrop(args)) return;
    captured(...args);
  };
  installed = true;
  return true;
}

/** Test-only — undo the wrap. Returns true if it actually uninstalled. */
export function uninstallLettaClientValidationFilter(target: WarnTarget = console as WarnTarget): boolean {
  if (!installed || !originalWarn) return false;
  target.warn = originalWarn;
  originalWarn = null;
  installed = false;
  return true;
}
