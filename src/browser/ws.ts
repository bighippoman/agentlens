/**
 * Minimal WebSocket client built on Node.js `net`/`tls` modules.
 * Implements just enough of RFC 6455 for Chrome DevTools Protocol:
 * - Client-side text frames (CDP is JSON only)
 * - Ping/pong handling
 * - Close frame handling
 * - Masking (required for client → server)
 *
 * Zero npm dependencies.
 */

import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { URL } from "node:url";

const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface WSOptions {
  timeout?: number;
}

export class WebSocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  /**
   * Connect to a WebSocket URL (ws:// or wss://).
   */
  async connect(url: string, options?: WSOptions): Promise<void> {
    const timeout = options?.timeout ?? 10000;
    const parsed = new URL(url);
    const isSecure = parsed.protocol === "wss:";
    const port = parseInt(parsed.port || (isSecure ? "443" : "80"), 10);
    const host = parsed.hostname;
    const path = parsed.pathname + parsed.search;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket connection timed out after ${timeout}ms`));
      }, timeout);

      // Create raw TCP/TLS socket
      const socket = isSecure
        ? tlsConnect({ host, port, rejectUnauthorized: false })
        : createConnection({ host, port });

      this.socket = socket;

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Send HTTP upgrade request
      const key = randomBytes(16).toString("base64");
      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        ``,
        ``,
      ].join("\r\n");

      socket.write(request);

      let handshakeBuffer = Buffer.alloc(0);
      let handshakeComplete = false;

      const onData = (chunk: Buffer) => {
        if (handshakeComplete) {
          this.onSocketData(chunk);
          return;
        }

        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        // Verify the upgrade response
        const headerStr = handshakeBuffer.subarray(0, headerEnd).toString();
        if (!headerStr.includes("101")) {
          clearTimeout(timer);
          reject(new Error(`WebSocket upgrade failed: ${headerStr.split("\r\n")[0]}`));
          return;
        }

        // Verify upgrade response headers (case-insensitive)
        const headerLower = headerStr.toLowerCase();
        if (!headerLower.includes("upgrade") || !headerLower.includes("websocket")) {
          clearTimeout(timer);
          reject(new Error("WebSocket upgrade response missing required headers"));
          return;
        }

        handshakeComplete = true;
        clearTimeout(timer);

        // Process any remaining data after the headers
        const remaining = handshakeBuffer.subarray(headerEnd + 4);
        if (remaining.length > 0) {
          this.onSocketData(remaining);
        }

        resolve();
      };

      socket.on("data", onData);

      socket.on("close", () => {
        this.closed = true;
        this.emit("close");
      });
    });
  }

  /**
   * Send a text message.
   */
  send(data: string): void {
    if (this.closed || !this.socket) {
      throw new Error("WebSocket is not connected");
    }
    const payload = Buffer.from(data, "utf-8");
    const frame = this.buildFrame(OPCODES.TEXT, payload);
    this.socket.write(frame);
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.closed || !this.socket) return;
    this.closed = true;
    try {
      const frame = this.buildFrame(OPCODES.CLOSE, Buffer.alloc(0));
      this.socket.write(frame);
      this.socket.end();
    } catch {
      // Socket may already be dead
    }
    this.emit("close");
  }

  get isOpen(): boolean {
    return !this.closed && this.socket !== null;
  }

  // ── Frame building ──

  private buildFrame(opcode: number, payload: Buffer): Buffer {
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i]! ^ mask[i % 4]!;
    }

    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = 0x80 | payload.length; // MASK + length
      mask.copy(header, 2);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      // Node Buffer doesn't have writeUInt64, split into two 32-bit writes
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
      mask.copy(header, 10);
    }

    return Buffer.concat([header, masked]);
  }

  // ── Frame parsing ──

  private onSocketData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0]!;
      const secondByte = this.buffer[1]!;

      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return; // Need more data
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        // Read as two 32-bit values (JS safe integer range)
        payloadLength = this.buffer.readUInt32BE(6);
        offset = 10;
      }

      if (isMasked) offset += 4;

      const totalLength = offset + payloadLength;
      if (this.buffer.length < totalLength) return; // Need more data

      let payload = this.buffer.subarray(offset, totalLength);

      if (isMasked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        payload = Buffer.alloc(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          payload[i] = this.buffer[offset + i]! ^ mask[i % 4]!;
        }
      }

      // Consume this frame from the buffer
      this.buffer = this.buffer.subarray(totalLength);

      // Handle by opcode
      switch (opcode) {
        case OPCODES.TEXT:
          this.emit("message", payload.toString("utf-8"));
          break;
        case OPCODES.BINARY:
          this.emit("message", payload.toString("utf-8"));
          break;
        case OPCODES.PING:
          // Respond with pong
          if (this.socket && !this.closed) {
            this.socket.write(this.buildFrame(OPCODES.PONG, payload));
          }
          break;
        case OPCODES.PONG:
          // Ignore
          break;
        case OPCODES.CLOSE:
          this.close();
          break;
      }
    }
  }
}
