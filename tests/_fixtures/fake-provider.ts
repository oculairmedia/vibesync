import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from '../../src/orchestration/runtime/index.js';

export type FakeProviderScript = (spec: SessionSpec) => AsyncIterable<SessionEvent>;

export interface FakeProviderRecorder {
  readonly starts: SessionSpec[];
  readonly prompts: { readonly handle: SessionHandle; readonly content: readonly ContentBlock[] }[];
  readonly stops: SessionHandle[];
  readonly nudges: SessionHandle[];
}

export interface FakeProvider extends RuntimeProvider {
  readonly recorder: FakeProviderRecorder;
}

export function newFakeProvider(args: { readonly kind?: string; readonly script?: FakeProviderScript } = {}): FakeProvider {
  const kind = args.kind ?? 'fake';
  const recorder: FakeProviderRecorder = {
    starts: [],
    prompts: [],
    stops: [],
    nudges: [],
  };
  const handles = new Map<string, SessionSpec>();
  let sequence = 0;

  return {
    kind,
    recorder,
    async start(spec: SessionSpec): Promise<SessionHandle> {
      sequence++;
      const handle = { id: `${kind}:${spec.role}-${sequence}`, providerKind: kind };
      recorder.starts.push(spec);
      handles.set(handle.id, spec);
      return handle;
    },
    async stop(handle: SessionHandle): Promise<void> {
      recorder.stops.push(handle);
    },
    async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
      recorder.prompts.push({ handle, content });
      return { taskId: `${handle.id}:prompt-${recorder.prompts.length}` };
    },
    async nudge(handle: SessionHandle): Promise<void> {
      recorder.nudges.push(handle);
    },
    observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
      const spec = handles.get(handle.id);
      if (!spec) {
        throw new Error(`FakeProvider.observe: unknown handle ${handle.id}`);
      }
      return args.script?.(spec) ?? defaultScript();
    },
  };
}

async function* defaultScript(): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'turn-done', ts };
}
