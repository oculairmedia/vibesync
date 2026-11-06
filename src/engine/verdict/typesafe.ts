/**
 * The TypeSafe (Jev) client the engine uses for step verdicts (vibesync-9lzk.39).
 *
 * One request per step reply, every question in it (they share the state and
 * run in parallel). A failed call is an ERROR, never an answer: the dispatcher
 * must not read a network failure as "no change requested".
 */
import { STEP_REPLY_QUESTIONS, type StepReplyState } from './questions.js';
import type { StepReplyAnswers } from './decide.js';

export interface StepReplyJudge {
  judge(state: StepReplyState): Promise<{ readonly answers: StepReplyAnswers; readonly model: string; readonly inputTokens: number }>;
}

export interface TypeSafeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class TypeSafeConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'TypeSafeConfigError'; }
}

export class TypeSafeRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'TypeSafeRequestError'; }
}

export function createTypeSafeJudge(opts: TypeSafeOptions): StepReplyJudge {
  if (!opts.apiKey) throw new TypeSafeConfigError('TypeSafe judge: apiKey is required (TYPESAFE_API_KEY)');
  const endpoint = opts.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
  const model = opts.model ?? 'jev-latest';
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async judge(state) {
      const payload = { model, state, questions: STEP_REPLY_QUESTIONS };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        throw new TypeSafeRequestError(`TypeSafe request failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      if (!res.ok) throw new TypeSafeRequestError(`TypeSafe HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      let body: { model?: string; answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number }; error?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new TypeSafeRequestError(`TypeSafe returned non-JSON: ${text.slice(0, 200)}`);
      }
      if (body.error) throw new TypeSafeRequestError(`TypeSafe error: ${JSON.stringify(body.error).slice(0, 300)}`);
      const answers: Record<string, number> = {};
      for (const id of Object.keys(STEP_REPLY_QUESTIONS)) {
        const p = body.answers?.[id]?.noul;
        if (typeof p !== 'number' || !Number.isFinite(p)) throw new TypeSafeRequestError(`TypeSafe answer missing for question "${id}"`);
        answers[id] = p;
      }
      return { answers: answers as StepReplyAnswers, model: body.model ?? model, inputTokens: body.usage?.input_tokens ?? 0 };
    },
  };
}
