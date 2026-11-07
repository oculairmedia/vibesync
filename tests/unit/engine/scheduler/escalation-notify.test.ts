/**
 * vibesync-9lzk.53: an escalated run tells the project PM and leaves the reason on the bead.
 * The reason below is the real d28l escalation from the 2026-11-06 backlog run.
 */
import { describe, expect, it } from 'vitest';

import { createEscalationNotifier } from '../../../../src/engine/scheduler/escalation-notify.js';

const D28L_REASON = 'FormulaDispatcher: step "reviewer" escalated: **Concerns:**\n- [block] `src/engine/molecule/recovery.ts:68` — Recovery resumes the running step but never reconstructs the molecule live run context. (review loop exhausted after 3 rounds; escalated)';

describe('escalation notifier', () => {
  it('wakes the PM naming the bead and the first line of the reason, and comments the full reason on the bead', async () => {
    const wakes: Array<[string, string]> = [];
    const comments: Array<[string, string]> = [];
    const notify = createEscalationNotifier({
      wakePm: (id, detail) => { wakes.push([id, detail]); },
      commentOnBead: async (id, text) => { comments.push([id, text]); },
    });
    await notify({ workBeadId: 'vibesync-d28l', contextId: 'wisp-1', reason: D28L_REASON });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]![0]).toBe('vibesync-d28l');
    expect(wakes[0]![1]).toContain('escalated, needs the PM');
    expect(wakes[0]![1]).not.toContain('\n');
    expect(comments).toHaveLength(1);
    expect(comments[0]![0]).toBe('vibesync-d28l');
    expect(comments[0]![1]).toContain('ENGINE ESCALATION (context wisp-1)');
    expect(comments[0]![1]).toContain('recovery.ts:68');
  });

  it('works with PM wake disabled (no waker): the bead comment is still posted', async () => {
    const comments: string[] = [];
    await createEscalationNotifier({ commentOnBead: async (_id, t) => { comments.push(t); } })({ workBeadId: 'b', contextId: 'c', reason: 'r' });
    expect(comments).toHaveLength(1);
  });

  it('a failing wake does not stop the comment, and a failing comment does not throw; both are logged', async () => {
    const warns: string[] = [];
    const comments: string[] = [];
    const logger = { warn: (_o: unknown, m: string) => { warns.push(m); } };
    await createEscalationNotifier({ wakePm: () => { throw new Error('iroh down'); }, commentOnBead: async (_i, t) => { comments.push(t); }, logger })({ workBeadId: 'b', contextId: 'c', reason: 'r' });
    expect(comments).toHaveLength(1);
    expect(warns).toEqual(['escalation-notify: PM wake failed']);
    warns.length = 0;
    await expect(createEscalationNotifier({ commentOnBead: async () => { throw new Error('bd down'); }, logger })({ workBeadId: 'b', contextId: 'c', reason: 'r' })).resolves.toBeUndefined();
    expect(warns).toEqual(['escalation-notify: bead comment failed']);
  });

  it('truncates a very long reason', async () => {
    const comments: string[] = [];
    await createEscalationNotifier({ commentOnBead: async (_i, t) => { comments.push(t); } })({ workBeadId: 'b', contextId: 'c', reason: 'x'.repeat(5000) });
    expect(comments[0]!.length).toBeLessThan(1800);
    expect(comments[0]).toContain('[truncated]');
  });
});
