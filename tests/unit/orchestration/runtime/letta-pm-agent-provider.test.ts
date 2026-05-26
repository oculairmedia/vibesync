import { describe, expect, it, vi } from 'vitest';

import {
  LettaPMAgentProvider,
  type LettaPMAgentServices,
} from '../../../../src/orchestration/runtime/index.js';

/**
 * Smoke-test the RuntimeProvider contract on LettaPMAgentProvider. The
 * hot-path observe stream is currently a SKELETON yielding a synthetic
 * started/turn-done bracket (see provider.ts for the deferral note);
 * these tests pin the interface shape and the handle-routing
 * discipline, not the full stream.
 */

function buildServices(overrides: Partial<LettaPMAgentServices> = {}): LettaPMAgentServices {
  const lifecycle = {
    ensureAgent: vi.fn(async (projectId: string) => ({
      id: `agent-${projectId}`,
      name: `pm-${projectId}`,
    })),
  };
  const client = {
    agents: {
      messages: {
        create: vi.fn(async () => undefined),
      },
    },
  };
  return { lifecycle, client, ...overrides };
}

describe('LettaPMAgentProvider', () => {
  describe('start', () => {
    it('requires projectId in spec.extra', async () => {
      const provider = new LettaPMAgentProvider(buildServices());
      await expect(provider.start({ role: 'pm' })).rejects.toThrow(/projectId is required/);
    });

    it('returns a handle scoped to the project and agent id', async () => {
      const services = buildServices();
      const provider = new LettaPMAgentProvider(services);
      const handle = await provider.start({ role: 'pm', extra: { projectId: 'demo' } });
      expect(handle.providerKind).toBe('letta-pm-agent');
      expect(handle.id).toBe('letta-pm:demo:agent-demo');
      expect(services.lifecycle.ensureAgent).toHaveBeenCalledWith('demo', undefined);
    });

    it('forwards controlAgentName override when provided', async () => {
      const services = buildServices();
      const provider = new LettaPMAgentProvider(services);
      await provider.start({
        role: 'pm',
        extra: { projectId: 'demo', controlAgentName: 'CustomPM' },
      });
      expect(services.lifecycle.ensureAgent).toHaveBeenCalledWith('demo', 'CustomPM');
    });
  });

  describe('prompt', () => {
    it('rejects handles from other providers', async () => {
      const provider = new LettaPMAgentProvider(buildServices());
      await expect(
        provider.prompt({ id: 'x', providerKind: 'other-provider' } as never, [
          { type: 'text', text: 'hi' },
        ]),
      ).rejects.toThrow(/handle from wrong provider/);
    });

    it('flattens a single text block to a plain string for legacy server compat', async () => {
      const services = buildServices();
      const provider = new LettaPMAgentProvider(services);
      const handle = await provider.start({ role: 'pm', extra: { projectId: 'demo' } });
      await provider.prompt(handle, [{ type: 'text', text: 'hello' }]);
      expect(services.client.agents.messages.create).toHaveBeenCalledWith('agent-demo', {
        messages: [{ role: 'user', content: 'hello' }],
      });
    });

    it('sends multi-part content as an array of typed parts', async () => {
      const services = buildServices();
      const provider = new LettaPMAgentProvider(services);
      const handle = await provider.start({ role: 'pm', extra: { projectId: 'demo' } });
      await provider.prompt(handle, [
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/jpeg', data: 'ZmFrZQ==' },
      ]);
      const createFn = services.client.agents.messages.create as ReturnType<typeof vi.fn>;
      const lastCall = createFn.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      expect(lastCall![1]).toEqual({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look at this' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' },
              },
            ],
          },
        ],
      });
    });
  });

  describe('observe', () => {
    it('yields a started → turn-done bracket (skeleton)', async () => {
      const provider = new LettaPMAgentProvider(buildServices());
      const handle = await provider.start({ role: 'pm', extra: { projectId: 'demo' } });
      const events: string[] = [];
      for await (const ev of provider.observe(handle)) {
        events.push(ev.kind);
      }
      expect(events).toEqual(['started', 'turn-done']);
    });
  });

  describe('stop and nudge', () => {
    it('stop is a no-op (PM agents are persistent per project)', async () => {
      const provider = new LettaPMAgentProvider(buildServices());
      const handle = await provider.start({ role: 'pm', extra: { projectId: 'demo' } });
      await expect(provider.stop(handle)).resolves.toBeUndefined();
    });

    it('nudge is a no-op (Letta REST has no nudge verb)', async () => {
      const provider = new LettaPMAgentProvider(buildServices());
      const handle = await provider.start({ role: 'pm', extra: { projectId: 'demo' } });
      await expect(provider.nudge(handle)).resolves.toBeUndefined();
    });
  });
});
