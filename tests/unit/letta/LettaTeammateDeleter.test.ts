import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fetchWithPool } = vi.hoisted(() => ({ fetchWithPool: vi.fn() }));

vi.mock('../../../src/http', () => ({ fetchWithPool }));

import { LettaTeammateDeleter } from '../../../src/letta/LettaTeammateDeleter';

function newDeleter(timeoutMs = 5_000): LettaTeammateDeleter {
  return new LettaTeammateDeleter({
    apiURL: 'https://letta.test/v1',
    password: 'sekret',
    timeoutMs,
  });
}

beforeEach(() => { fetchWithPool.mockReset(); });

describe('LettaTeammateDeleter (vibesync-6zj)', () => {
  it('issues DELETE /v1/agents/<id> with bearer auth', async () => {
    fetchWithPool.mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    await newDeleter().delete('agent-7');
    expect(fetchWithPool).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithPool.mock.calls[0]!;
    expect(url).toBe('https://letta.test/v1/agents/agent-7');
    expect(init.method).toBe('DELETE');
    expect(init.headers).toEqual({ Authorization: 'Bearer sekret' });
  });

  it('treats HTTP 404 as idempotent success (already gone)', async () => {
    fetchWithPool.mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response);
    await expect(newDeleter().delete('agent-gone')).resolves.toBeUndefined();
  });

  it('throws on other non-OK responses, including the body in the message', async () => {
    fetchWithPool.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'kaboom',
    } as unknown as Response);
    await expect(newDeleter().delete('agent-x')).rejects.toThrow(/HTTP 500: kaboom/);
  });

  it('passes an AbortSignal.timeout to fetch so the call cannot hang forever', async () => {
    fetchWithPool.mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    await newDeleter(1234).delete('agent-1');
    const init = fetchWithPool.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
    // Sanity: it really is an AbortSignal (not just any truthy value).
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces the timeout as a thrown AbortError when fetch is slow', async () => {
    // Simulate fetch hanging until the signal aborts.
    fetchWithPool.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          // Real fetch raises this shape; preserve it for the test.
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    const start = Date.now();
    await expect(newDeleter(50).delete('agent-stall')).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
