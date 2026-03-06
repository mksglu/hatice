import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { secureHeaders } from 'hono/secure-headers';
import type { Orchestrator } from './orchestrator.js';
import { createLogger } from './logger.js';
import { SSEBroadcaster } from './sse-broadcaster.js';
import { withTimeout, TimeoutError } from './snapshot-timeout.js';
import type { EventBus } from './event-bus.js';
import type { OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry, haticeEvents } from './types.js';
import { renderLiveDashboard } from './dashboard-template.js';

export class HttpServer {
  private app: Hono;
  private orchestrator: Pick<Orchestrator, 'getState' | 'refresh'>;
  private host: string;
  private port: number;
  private log;
  private server: ReturnType<typeof serve> | null = null;
  private sseBroadcaster: SSEBroadcaster | null = null;
  private eventBus: EventBus<haticeEvents> | null = null;

  static SNAPSHOT_TIMEOUT_MS = 15000;

  constructor(orchestrator: Pick<Orchestrator, 'getState' | 'refresh'>, port: number, host = '127.0.0.1', eventBus?: EventBus<haticeEvents>) {
    this.orchestrator = orchestrator;
    this.port = port;
    this.host = host;
    this.log = createLogger({ component: 'http-server' });
    this.app = new Hono();
    this.app.use('*', secureHeaders());

    if (eventBus) {
      this.eventBus = eventBus;
      this.sseBroadcaster = new SSEBroadcaster();
      this.eventBus.onAny((event: string, ...args: unknown[]) => {
        this.sseBroadcaster!.broadcast(event, args);
      });
    }

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // HTML dashboard — uses Tailwind-based live template
    this.app.get('/', (c) => {
      const snapshot = this.orchestrator.getState().snapshot();
      return c.html(renderLiveDashboard(snapshot));
    });

    // SSE endpoint — real-time events
    if (this.sseBroadcaster) {
      const broadcaster = this.sseBroadcaster;
      this.app.get('/api/v1/events', (_c) => {
        let clientId: string;
        const stream = new ReadableStream({
          start(controller) {
            clientId = crypto.randomUUID();
            const encoder = new TextEncoder();
            const writer = new WritableStream({
              write(chunk) {
                try {
                  controller.enqueue(encoder.encode(chunk));
                } catch {
                  // Stream closed
                }
              },
            }).getWriter();
            broadcaster.addClient(clientId, writer);
          },
          cancel() {
            broadcaster.removeClient(clientId);
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      });
    }

    // JSON API — full state
    this.app.get('/api/v1/state', async (c) => {
      try {
        const snapshot = await withTimeout(
          () => this.orchestrator.getState().snapshot(),
          HttpServer.SNAPSHOT_TIMEOUT_MS,
        );
        return c.json(snapshot);
      } catch (err) {
        if (err instanceof TimeoutError) {
          return c.json({ error: 'Snapshot timeout' }, 503);
        }
        throw err;
      }
    });

    // JSON API — single issue lookup
    this.app.get('/api/v1/:id', async (c) => {
      const id = c.req.param('id');
      let snapshot: OrchestratorSnapshot;
      try {
        snapshot = await withTimeout(
          () => this.orchestrator.getState().snapshot(),
          HttpServer.SNAPSHOT_TIMEOUT_MS,
        );
      } catch (err) {
        if (err instanceof TimeoutError) {
          return c.json({ error: 'Snapshot timeout' }, 503);
        }
        throw err;
      }
      const entry = snapshot.running.find((r: SnapshotRunningEntry) => r.issueId === id);
      if (!entry) {
        const retrying = snapshot.retrying.find((r: SnapshotRetryEntry) => r.issueId === id);
        if (retrying) return c.json(retrying);
        return c.json({ error: 'Issue not found' }, 404);
      }
      return c.json(entry);
    });

    // JSON API — force refresh
    this.app.post('/api/v1/refresh', async (c) => {
      await this.orchestrator.refresh();
      return c.json({ ok: true });
    });
  }

  getApp(): Hono {
    return this.app;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = serve({ fetch: this.app.fetch, port: this.port, hostname: this.host }, () => {
        this.log.info({ port: this.port, host: this.host }, 'HTTP server started');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.log.info('HTTP server stopped');
  }
}
