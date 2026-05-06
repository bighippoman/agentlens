/**
 * Chrome DevTools Protocol client.
 *
 * Sends JSON-RPC commands and receives events over WebSocket.
 * Uses our own WebSocket client — zero npm dependencies.
 */

import { WebSocketClient } from "./ws.js";

export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export type CDPEventHandler = (params: Record<string, unknown>) => void;

export class CDPClient {
  private ws: WebSocketClient;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private eventHandlers = new Map<string, CDPEventHandler[]>();

  constructor() {
    this.ws = new WebSocketClient();
  }

  /**
   * Connect to a Chrome DevTools WebSocket endpoint.
   */
  async connect(wsUrl: string): Promise<void> {
    await this.ws.connect(wsUrl, { timeout: 10000 });

    this.ws.on("message", (data: string) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      // Response to a command
      if (msg.id !== undefined) {
        const handler = this.pending.get(msg.id);
        if (handler) {
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            handler.resolve(msg.result ?? {});
          }
        }
        return;
      }

      // Event
      if (msg.method) {
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) {
            h(msg.params ?? {});
          }
        }
      }
    });

    this.ws.on("close", () => {
      // Reject all pending commands
      for (const [, handler] of this.pending) {
        handler.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params: params ?? {} });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after 30s`));
      }, 30000);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws.send(message);
    });
  }

  /**
   * Subscribe to a CDP event.
   */
  on(event: string, handler: CDPEventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, handler: CDPEventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      this.eventHandlers.set(event, handlers.filter((h) => h !== handler));
    }
  }

  /**
   * Close the connection.
   */
  close(): void {
    this.ws.close();
  }

  get connected(): boolean {
    return this.ws.isOpen;
  }
}
