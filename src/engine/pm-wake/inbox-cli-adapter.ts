import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

import type { InboxMessageAdapter } from './inbox-sink.js';

export interface InboxCliOptions {
  /** Exact matched distribution executable, not the turn-scoped meridian shim. */
  readonly executable: string;
  readonly senderAgentId: string;
  readonly identityDir: string;
  readonly addressStore: string;
  /** Set by composition only after the matched sender/ACK contract is verified. */
  readonly contractVerified: boolean;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** One invocation per logical send; ambiguous outcomes never generate a new ID. */
export function createInboxCliAdapter(options: InboxCliOptions): InboxMessageAdapter {
  if (!options.contractVerified) throw new Error('Inbox sender contract has not been verified');
  for (const value of [options.executable, options.identityDir, options.addressStore]) {
    if (!isAbsolute(value)) throw new Error('Inbox sender paths must be absolute');
  }
  if (!options.senderAgentId.trim()) throw new Error('Inbox sender identity is required');

  return {
    async sendInboxMessage(input) {
      if (!input.msgId.trim() || !input.to.trim()) throw new Error('Inbox target and stable msgId are required');
      const args = [
        'agent-message', 'send', '--from', options.senderAgentId,
        '--to', input.to, '--msg-id', input.msgId, '--body-file', '-',
        '--identity-dir', options.identityDir, '--address-store', options.addressStore,
      ];
      if (input.correlation) {
        if (Object.values(input.correlation).some((v) => typeof v !== 'string')) {
          throw new Error('Inbox correlation must be a string map');
        }
        args.push('--correlation-json', JSON.stringify(input.correlation));
      }
      // No lane or conversation override: the receiver owns inbox resolution.
      return new Promise<unknown>((resolve, reject) => {
        const child = spawn(options.executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let bytes = 0;
        let failure: Error | undefined;
        const timer = setTimeout(() => {
          failure = new Error('Inbox sender timed out; delivery is unknown');
          child.kill('SIGKILL');
        }, TIMEOUT_MS);
        const consume = (chunk: Buffer, stdout: boolean): void => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            failure = new Error('Inbox sender output exceeded limit; delivery is unknown');
            child.kill('SIGKILL');
          } else if (stdout) output += chunk.toString('utf8');
        };
        child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
        child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
        child.stdin.on('error', () => {
          failure ??= new Error('Inbox sender input failed; delivery is unknown');
        });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failure) return reject(failure);
          if (code !== 0 && code !== 1) return reject(new Error('Inbox sender exited unexpectedly; delivery is unknown'));
          try {
            // Exit 1 also carries Accepted/Unaddressable/Failed JSON; never discard its reason.
            const ack: unknown = JSON.parse(output.trim());
            resolve(ack);
          } catch {
            reject(new Error('Inbox sender returned invalid JSON; delivery is unknown'));
          }
        });
        child.stdin.end(input.body);
      });
    },
  };
}
