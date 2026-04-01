import { describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "@terminal-platform/protocol";
import { encodeBinaryFrame } from "@terminal-platform/protocol";

import { TerminalConnection } from "../src/index.js";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;

  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  constructor(public readonly url: string) {
    super();
  }

  send(payload: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(payload);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

describe("TerminalConnection", () => {
  it("sends auth on open and forwards server messages", () => {
    const messages: ServerMessage[] = [];
    const frames: string[] = [];
    let socket: FakeSocket | null = null;

    const connection = new TerminalConnection({
      url: "ws://localhost:8787/ws",
      auth: {
        token: "token",
        sessionId: "session-1",
        cols: 120,
        rows: 40,
      },
      WebSocketImpl: class extends FakeSocket {
        constructor(url: string) {
          super(url);
          socket = this;
        }
      } as unknown as typeof WebSocket,
    });

    connection.connect({
      onMessage(message) {
        messages.push(message);
      },
      onBinaryFrame(frame) {
        frames.push(frame.kind);
      },
    });

    socket?.dispatchEvent(new Event("open"));
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ready",
          sessionId: "session-1",
          protocolVersion: 1,
          reconnectable: true,
        }),
      }),
    );
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: encodeBinaryFrame({
          kind: "snapshot",
          data: new Uint8Array([65]),
        }).buffer,
      }),
    );

    expect(socket?.sent[0]).toContain("\"type\":\"auth\"");
    expect(messages[0]?.type).toBe("ready");
    expect(frames).toEqual(["snapshot"]);
  });

  it("schedules reconnects after unexpected close", () => {
    vi.useFakeTimers();

    let opens = 0;

    const connection = new TerminalConnection({
      url: "ws://localhost:8787/ws",
      auth: {
        token: "token",
        sessionId: "session-2",
        cols: 80,
        rows: 24,
      },
      reconnectDelayMs: 10,
      WebSocketImpl: class extends FakeSocket {
        constructor(url: string) {
          super(url);
          opens += 1;
        }
      } as unknown as typeof WebSocket,
    });

    connection.connect({});
    expect(opens).toBe(1);

    (connection as unknown as { socket: FakeSocket }).socket?.dispatchEvent(
      new Event("close"),
    );

    vi.advanceTimersByTime(10);
    expect(opens).toBe(2);
    vi.useRealTimers();
  });
});
