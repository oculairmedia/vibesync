import type { EventBus } from '../events/index.js';
import type { RuntimeSessionEventContext } from './types.js';
import type { SessionEvent } from '../runtime/index.js';

export function createDispatcherEmitter(eventBus: EventBus): {
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly emitRuntimeSessionEvent: (event: SessionEvent, context: RuntimeSessionEventContext) => void;
} {
  return {
    emit: (kind, moleculeId, taskId, payload) => {
      eventBus.emit({
        layer: 'dispatcher',
        kind,
        ...(moleculeId ? { molecule_id: moleculeId } : {}),
        ...(taskId ? { task_id: taskId } : {}),
        payload,
      });
    },
    emitRuntimeSessionEvent: (event, context) => {
      eventBus.emit({
        layer: 'runtime',
        kind: `runtime/session.${event.kind.replace(/-/g, '_')}`,
        molecule_id: context.moleculeId,
        ...(context.taskId ? { task_id: context.taskId } : {}),
        teammate: context.role,
        payload: {
          ...sessionEventPayload(event),
          stepId: context.stepId,
          stepName: context.stepName,
          role: context.role,
          providerKind: context.providerKind,
          sessionId: context.sessionId,
          ...(context.attempt ? { attempt: context.attempt } : {}),
          ...(context.taskId ? { taskId: context.taskId } : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          ...(context.agentId ? { agentId: context.agentId } : {}),
          ...(context.projectIdentifier ? { projectIdentifier: context.projectIdentifier } : {}),
          ...(context.resumed ? { resumed: true } : {}),
        },
      });
    },
  };
}

function sessionEventPayload(event: SessionEvent): Readonly<Record<string, unknown>> {
  const base = { eventKind: event.kind, ts: event.ts };
  const payloads: { [K in SessionEvent['kind']]: (event: Extract<SessionEvent, { kind: K }>) => Readonly<Record<string, unknown>> } = {
    started: () => base,
    'first-token': () => base,
    stopped: () => base,
    'message-delta': (value) => ({ ...base, text: value.text, textLength: value.text.length }),
    'tool-call': (value) => ({ ...base, tool: value.tool, args: value.args }),
    'tool-result': (value) => ({ ...base, tool: value.tool, result: value.result, ok: value.ok }),
    usage: (value) => ({ ...base, prompt: value.prompt, completion: value.completion }),
    'turn-done': (value) => ({ ...base, ...(value.stopReason ? { stopReason: value.stopReason } : {}) }),
    error: (value) => ({ ...base, code: value.code, message: value.message }),
  };
  return (payloads[event.kind] as (value: SessionEvent) => Readonly<Record<string, unknown>>)(event);
}
