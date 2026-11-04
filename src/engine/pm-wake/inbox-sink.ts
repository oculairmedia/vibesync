/**
 * Inbox delivery for PM wakes: the adapter port a mailbox sender implements,
 * strict acknowledgement parsing, and the PmWakeSink built on top of them.
 */
import { formatWakeMessage, type PmWakeSink } from './contract.js';

export interface InboxMessageAck {
  readonly msgId: string;
  readonly accepted: boolean;
  readonly applicationDelivered: boolean;
  readonly reason?: string;
}

export interface InboxMessageAdapter {
  sendInboxMessage(input: {
    readonly to: string;
    readonly body: string;
    readonly msgId: string;
    readonly correlation?: Readonly<Record<string, string>>;
  }): Promise<unknown>;
}

export function createInboxWakeSink(adapter: InboxMessageAdapter): PmWakeSink {
  return {
    wake: async (input) => {
      const rawAck = await adapter.sendInboxMessage({
        to: input.agentId,
        body: formatWakeMessage(input),
        msgId: input.wakeId,
        ...(input.correlation ? { correlation: input.correlation } : {}),
      });
      const ack = normalizeInboxWakeAck(rawAck, input.wakeId);
      return {
        ok: ack?.accepted === true && ack.applicationDelivered,
        accepted: ack?.accepted ?? false,
        applicationDelivered: ack?.applicationDelivered ?? false,
        msgId: input.wakeId,
        ...(!ack ? { reason: 'malformed inbox acknowledgement' } : ack.reason ? { reason: ack.reason } : {}),
      };
    },
  };
}

export function normalizeInboxWakeAck(value: unknown, msgId: string): InboxMessageAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ack = value as Record<string, unknown>;
  if (ack['msgId'] !== msgId || typeof ack['accepted'] !== 'boolean') return null;
  if (ack['applicationDelivered'] !== undefined && typeof ack['applicationDelivered'] !== 'boolean') return null;
  if (ack['reason'] !== undefined && typeof ack['reason'] !== 'string') return null;
  return {
    msgId,
    accepted: ack['accepted'],
    applicationDelivered: ack['applicationDelivered'] === true,
    ...(typeof ack['reason'] === 'string' ? { reason: ack['reason'] } : {}),
  };
}
