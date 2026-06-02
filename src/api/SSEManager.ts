import { logger } from '../../src/logger';

interface SSEClient {
  id: string;
  res: unknown;
  connectedAt: number;
}

/**
 * lcp-vugl: SSE Bootstrap-Then-Stream Contract
 * 
 * This SSE manager implements a snapshot-on-connect pattern to eliminate the
 * blank-screen problem where a UI connecting mid-flight sees nothing until
 * the next event fires.
 * 
 * Connection flow:
 * 1. Client connects to /api/events/stream
 * 2. Server immediately sends:
 *    - event: connected { clientId, timestamp }
 *    - event: snapshot { molecules: [...], fleet: {...}, timestamp }
 * 3. Server then streams live delta events as they occur:
 *    - dispatcher/formula.queued, started, completed, failed, cancelled
 *    - dispatcher/step.started, finished, failed, retry
 *    - runtime/session.* events
 * 
 * Event payload structure:
 * - Top-level: { layer, kind, molecule_id?, task_id?, teammate?, payload }
 * - Payload includes: moleculeId, stepId, stepName, role, status, timestamp
 * 
 * This ensures a UI can:
 * - Render current fleet state immediately on connect (snapshot)
 * - Apply incremental updates as events arrive (deltas)
 * - Never show a blank screen while waiting for the next change
 */

export class SSEManager {
  clients = new Set<SSEClient>();

  /**
   * lcp-vugl: Add a new SSE client and optionally send an initial snapshot.
   * 
   * @param res - Response object to write SSE events to
   * @param snapshotFn - Optional async function that returns snapshot data to send immediately after connection
   * @returns clientId string
   */
  async addClient(res: unknown, snapshotFn?: () => Promise<Record<string, unknown>>): Promise<string> {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const resObj = res as { writeHead: (code: number, headers: Record<string, string>) => void; on: (event: string, cb: () => void) => void };

    resObj.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    this.sendEvent(res, 'connected', { clientId, timestamp: new Date().toISOString() });

    // lcp-vugl: send initial snapshot if provided, so the client renders current state immediately
    if (snapshotFn) {
      try {
        const snapshot = await snapshotFn();
        this.sendEvent(res, 'snapshot', { ...snapshot, timestamp: new Date().toISOString() });
      } catch (error) {
        logger.error({ err: error, clientId }, 'Failed to send initial snapshot');
      }
    }

    const client: SSEClient = { id: clientId, res, connectedAt: Date.now() };
    this.clients.add(client);

    resObj.on('close', () => {
      this.clients.delete(client);
      logger.info({ clientId }, 'SSE client disconnected');
    });

    logger.info({ clientId, totalClients: this.clients.size }, 'SSE client connected');
    return clientId;
  }

  sendEvent(res: unknown, eventType: string, data: Record<string, unknown>): void {
    try {
      const resObj = res as { write: (chunk: string) => void };
      resObj.write(`event: ${eventType}\n`);
      resObj.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      logger.error({ err: error }, 'Failed to send SSE event');
    }
  }

  broadcast(eventType: string, data: Record<string, unknown>): void {
    const deadClients: SSEClient[] = [];
    for (const client of this.clients) {
      try {
        this.sendEvent(client.res, eventType, { ...data, timestamp: new Date().toISOString() });
      } catch {
        deadClients.push(client);
      }
    }
    for (const client of deadClients) {
      this.clients.delete(client);
    }
    logger.debug({ eventType, clientCount: this.clients.size, removedClients: deadClients.length }, 'Broadcast SSE event');
  }

  getClientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients) {
      try { (client.res as { end: () => void }).end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}

export const sseManager = new SSEManager();
