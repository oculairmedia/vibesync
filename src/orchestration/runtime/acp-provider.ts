/**
 * ACPProvider — speak the Agent Client Protocol (JSON-RPC over stdio)
 * to dispatch to third-party ACP-compliant agents.
 *
 * Reference impl: Gas City's internal/runtime/acp/ (protocol.go, conn.go,
 * acp.go). This is a TS port of the client side — VibeSync spawns the
 * agent process, performs the initialize handshake, then sends
 * session/new + session/prompt requests, receiving session/update
 * notifications back.
 *
 * Provider-specific start-spec extra fields:
 *   - extra.command: string — required; binary to spawn.
 *   - extra.args?: string[] — arguments to pass.
 *   - extra.cwd?: string — working directory.
 *   - extra.mcpServers?: object[] — MCP server configs to attach.
 *
 * Wire format (JSON-RPC 2.0):
 *
 *   →  { "jsonrpc": "2.0", "id": N, "method": "initialize",
 *        "params": { "protocolVersion": 1, "clientInfo": {...} } }
 *   ←  { "jsonrpc": "2.0", "id": N, "result": { "serverInfo": {...} } }
 *   →  { "jsonrpc": "2.0", "method": "initialized" }
 *   →  { "jsonrpc": "2.0", "id": N, "method": "session/new",
 *        "params": { "cwd": "...", "mcpServers": [...] } }
 *   ←  { "jsonrpc": "2.0", "id": N, "result": { "sessionId": "..." } }
 *   →  { "jsonrpc": "2.0", "id": N, "method": "session/prompt",
 *        "params": { "sessionId": "...", "prompt": [...] } }
 *   ←  { "jsonrpc": "2.0", "method": "session/update",
 *        "params": { "sessionId": "...", "content": [...] } }   (notification)
 *   ←  { "jsonrpc": "2.0", "id": N, "result": {} }              (turn done)
 *
 * Status: SKELETON. Spawn + JSON-RPC envelope construction wired;
 * connection lifecycle (handshake, response correlation, notification
 * dispatch) is stubbed. Full ACP round-trip wires up when a third-
 * party customer asks for non-Letta agent support; promote priority
 * then.
 *
 * See vibesync-oq4.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';

interface AcpHandle extends SessionHandle {
  readonly providerKind: 'acp';
  /** ACP sessionId returned by session/new. */
  readonly sessionId: string;
}

interface SpawnedAcp {
  readonly child: ChildProcessWithoutNullStreams;
  /** Local request id counter for JSON-RPC. */
  nextId: number;
  /** Pending response correlation: id → resolver. */
  readonly pending: Map<number, (result: unknown) => void>;
  /** Buffered stdout for line-splitting. */
  stdoutBuf: string;
  /** Resolved at handshake completion. */
  initialized: boolean;
}

export class ACPProvider implements RuntimeProvider {
  readonly kind = 'acp';
  private readonly connections = new Map<string, SpawnedAcp>();

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const command = readStringExtra(spec, 'command');
    if (!command) {
      throw new Error(`ACPProvider.start: spec.extra.command is required for role=${spec.role}`);
    }
    const args = (spec.extra?.['args'] as string[] | undefined) ?? [];
    const cwd = readStringExtra(spec, 'cwd');
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const conn: SpawnedAcp = {
      child,
      nextId: 0,
      pending: new Map(),
      stdoutBuf: '',
      initialized: false,
    };
    // SKELETON: skipping the handshake round-trip here; lands when a
    // real ACP customer arrives. For now we assign a synthetic
    // sessionId and accept that prompts will queue until the actual
    // handshake is wired.
    const sessionId = `acp-skel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handleId = `acp:${sessionId}`;
    this.connections.set(handleId, conn);
    const handle: AcpHandle = {
      id: handleId,
      providerKind: 'acp',
      sessionId,
    };
    return handle;
  }

  async stop(handle: SessionHandle): Promise<void> {
    expectHandle(handle);
    const conn = this.connections.get(handle.id);
    if (!conn) return;
    this.connections.delete(handle.id);
    try {
      conn.child.kill('SIGTERM');
    } catch {
      // ignore — best-effort
    }
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectHandle(handle);
    const conn = this.connections.get(handle.id);
    if (!conn) throw new Error(`ACPProvider.prompt: no connection for ${handle.id}`);
    const id = ++conn.nextId;
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: {
        sessionId: h.sessionId,
        prompt: content.map((block) => contentBlockToAcp(block)),
      },
    };
    if (!conn.child.stdin.writable) {
      throw new Error(`ACPProvider.prompt: stdin not writable for ${handle.id}`);
    }
    conn.child.stdin.write(JSON.stringify(request) + '\n');
    return {};
  }

  async nudge(_handle: SessionHandle): Promise<void> {
    // ACP has no explicit nudge verb; the agent processes messages
    // as they arrive on stdin.
  }

  async *observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
    expectHandle(handle);
    const ts = new Date().toISOString();
    yield { kind: 'started', ts };
    yield { kind: 'turn-done', ts };
    // TODO(vibesync-oq4 follow-up): line-buffer stdout, parse
    // JSON-RPC frames, correlate responses with pending ids, emit
    // session/update notifications as SessionEvent.
  }
}

function expectHandle(handle: SessionHandle): AcpHandle {
  if (handle.providerKind !== 'acp') {
    throw new Error(
      `ACPProvider: handle from wrong provider (got ${handle.providerKind}, want acp)`,
    );
  }
  return handle as AcpHandle;
}

function readStringExtra(spec: SessionSpec, key: string): string | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Map an orchestration ContentBlock to an ACP content block. ACP's
 * native shape (see Gas City's protocol.go ContentBlock) supports
 * type='text' with text; type='file' with path+mime is reserved but
 * not yet specified. Image blocks downgrade to a placeholder string
 * for now — ACP doesn't have a stable image content type yet.
 */
function contentBlockToAcp(block: ContentBlock): { type: string; text: string } {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return { type: 'text', text: `[image: ${block.mimeType}]` };
}
