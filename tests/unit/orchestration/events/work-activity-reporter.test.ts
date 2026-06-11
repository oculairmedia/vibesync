import { describe, expect, it, beforeEach } from 'vitest';

import { EventBus } from '../../../../src/orchestration/events/bus.js';
import { WorkActivityReporter } from '../../../../src/orchestration/events/work-activity-reporter.js';

describe('WorkActivityReporter', () => {
  describe('event filtering', () => {
    it('reports dispatcher/step.started events', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-1',
        task_id: 'task-abc',
        payload: { stepId: 'step-1', stepName: 'lint', role: 'coder', attempt: 1 },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.external_id).toBe('ext-vibesync-mol-1-step-1');
      expect(posts[0]!.body.status).toBe('running');
      expect(posts[0]!.body.description).toBe('coder: lint');
      expect(posts[0]!.body.task_ref).toBe('task-abc');
      expect(posts[0]!.body.source).toBe('vibesync');
    });

    it('reports dispatcher/step.finished events', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.finished',
        molecule_id: 'mol-2',
        payload: { stepId: 'step-2', stepName: 'test', role: 'tester' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.status).toBe('completed');
      expect(posts[0]!.body.description).toBe('tester: test');
    });

    it('reports dispatcher/step.failed events with failure_reason', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.failed',
        molecule_id: 'mol-3',
        payload: { stepId: 'step-3', stepName: 'build', role: 'coder', error: 'compilation failed' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.status).toBe('failed');
      expect(posts[0]!.body.failure_reason).toBe('compilation failed');
    });

    it('reports dispatcher/step.retry as running', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.retry',
        molecule_id: 'mol-4',
        payload: { stepId: 'step-4', stepName: 'format', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.status).toBe('running');
    });

    it('reports dispatcher/step.cancelled as failed', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.cancelled',
        molecule_id: 'mol-5',
        payload: { stepId: 'step-5', stepName: 'deploy', role: 'deployer' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.status).toBe('failed');
      expect(posts[0]!.body.failure_reason).toBe('cancelled');
    });

    it('ignores non-dispatcher events', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'runtime',
        kind: 'runtime/session.started',
        molecule_id: 'mol-6',
        payload: { stepId: 'step-6' },
      });
      await sleep(10);
      expect(posts).toHaveLength(0);
    });

    it('ignores dispatcher events not matching step.* kinds', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/formula.started',
        molecule_id: 'mol-7',
        payload: { stepId: 'step-7' },
      });
      await sleep(10);
      expect(posts).toHaveLength(0);
    });

    it('skips events missing required fields (molecule_id or stepId)', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      // Missing molecule_id
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        payload: { stepId: 'step-8', stepName: 'foo', role: 'bar' },
      });
      // Missing stepId
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-9',
        payload: { stepName: 'baz', role: 'qux' },
      });
      await sleep(10);
      expect(posts).toHaveLength(0);
    });

    it('handles missing stepName/role gracefully', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-10',
        payload: { stepId: 'step-10' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.description).toBe('worker: unknown');
    });
  });

  describe('fail-open behavior', () => {
    it('swallows fetch errors without blocking EventBus', async () => {
      const fetchMock = async (): Promise<Response> => {
        throw new Error('ECONNREFUSED');
      };
      const { bus, reporter } = setup({ fetchImpl: fetchMock });
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-11',
        payload: { stepId: 'step-11', stepName: 'test', role: 'coder' },
      });
      await sleep(10);
      // No exception thrown — EventBus subscriber is safe.
    });

    it('swallows non-2xx responses without blocking EventBus', async () => {
      const posts: PostRecord[] = [];
      const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
        const bodyText = init?.body ? String(init.body) : '{}';
        const body = JSON.parse(bodyText) as PostRecord['body'];
        posts.push({ url, body, status: 404 });
        return new Response('Not Found', { status: 404 });
      };
      const bus = new EventBus({ noPersist: true });
      const reporter = new WorkActivityReporter({
        eventBus: bus,
        shimBaseUrl: 'http://localhost:8291',
        fetchImpl: fetchMock,
      });
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-12',
        payload: { stepId: 'step-12', stepName: 'build', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.status).toBe(404);
    });

    it('aborts the fetch after timeout', async () => {
      let aborted = false;
      const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
          // Never resolve — timeout will fire.
        });
      };
      const { bus, reporter } = setup({ fetchImpl: fetchMock, timeoutMs: 50 });
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-13',
        payload: { stepId: 'step-13', stepName: 'wait', role: 'coder' },
      });
      await sleep(100);
      expect(aborted).toBe(true);
    });
  });

  describe('replay-safe (live tier only)', () => {
    it('only reports events emitted after start()', async () => {
      const { bus, reporter, posts } = setup();
      // Emit BEFORE start() — these should NOT be reported (no replay).
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-14',
        payload: { stepId: 'step-14', stepName: 'old', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(0);
      // Now start the reporter.
      reporter.start();
      // Emit AFTER start() — this SHOULD be reported.
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-15',
        payload: { stepId: 'step-15', stepName: 'new', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.external_id).toBe('ext-vibesync-mol-15-step-15');
    });
  });

  describe('lifecycle', () => {
    it('start() is idempotent', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      reporter.start();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-16',
        payload: { stepId: 'step-16', stepName: 'test', role: 'coder' },
      });
      await sleep(10);
      // Should only report once, not 3 times.
      expect(posts).toHaveLength(1);
    });

    it('stop() unsubscribes from EventBus', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-17',
        payload: { stepId: 'step-17', stepName: 'a', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      reporter.stop();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-18',
        payload: { stepId: 'step-18', stepName: 'b', role: 'coder' },
      });
      await sleep(10);
      // Still only 1 — the second event was not reported.
      expect(posts).toHaveLength(1);
    });

    it('stop() is idempotent', () => {
      const { reporter } = setup();
      reporter.start();
      reporter.stop();
      reporter.stop();
      reporter.stop();
      // No error thrown.
    });
  });

  describe('field mapping edge cases', () => {
    it('handles empty strings in stepName/role', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-19',
        payload: { stepId: 'step-19', stepName: '', role: '' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.description).toBe('worker: unknown');
    });

    it('includes task_ref only when task_id is present', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-20',
        payload: { stepId: 'step-20', stepName: 'test', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.task_ref).toBeUndefined();
    });

    it('includes failure_reason only for failed/cancelled events', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.started',
        molecule_id: 'mol-21',
        payload: { stepId: 'step-21', stepName: 'test', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.failure_reason).toBeUndefined();
    });

    it('defaults failure_reason to "step failed" when error is missing', async () => {
      const { bus, reporter, posts } = setup();
      reporter.start();
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/step.failed',
        molecule_id: 'mol-22',
        payload: { stepId: 'step-22', stepName: 'test', role: 'coder' },
      });
      await sleep(10);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.failure_reason).toBe('step failed');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test utilities
// ────────────────────────────────────────────────────────────────────────

interface PostRecord {
  url: string;
  body: {
    external_id: string;
    description: string;
    status: 'running' | 'completed' | 'failed';
    started_at: string;
    task_ref?: string;
    failure_reason?: string;
    source: 'vibesync';
  };
  status: number;
}

function setup(opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const bus = new EventBus({ noPersist: true });
  const posts: PostRecord[] = [];
  const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
    const bodyText = init?.body ? String(init.body) : '{}';
    const body = JSON.parse(bodyText) as PostRecord['body'];
    posts.push({ url, body, status: 200 });
    return new Response('{}', { status: 200 });
  };
  const reporter = new WorkActivityReporter({
    eventBus: bus,
    shimBaseUrl: 'http://localhost:8291',
    fetchImpl: opts?.fetchImpl ?? fetchMock,
    timeoutMs: opts?.timeoutMs,
  });
  return { bus, reporter, posts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
