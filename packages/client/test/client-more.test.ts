import { describe, expect, it, vi } from "vitest";

import { encodeBinaryFrame } from "@terminal-platform/protocol";

import { TerminalConnection } from "../src/index.js";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;

  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  send(payload: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(payload);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

describe("TerminalConnection more branches", () => {
  it("sends json messages and ignores send when closed", () => {
    let socket: FakeSocket | null = null;

    const connection = new TerminalConnection({
      url: "ws://localhost:8787/ws",
      auth: {
        token: "token",
        sessionId: "session-1",
        cols: 80,
        rows: 24,
      },
      WebSocketImpl: class extends FakeSocket {
        constructor() {
          super();
          socket = this;
        }
      } as unknown as typeof WebSocket,
    });

    connection.connect({});
    socket?.dispatchEvent(new Event("open"));
    connection.sendInput("ls\n");
    connection.resize(100, 30);
    connection.ping(123);
    expect(socket?.sent).toHaveLength(4);

    socket!.readyState = 0;
    connection.send({ type: "detach" });
    expect(socket?.sent).toHaveLength(4);
  });

  it("handles binary messages and avoids reconnect when client closes", () => {
    vi.useFakeTimers();
    let socket: FakeSocket | null = null;
    const binaryOutput = vi.fn();
    const binaryFrame = vi.fn();
    const onError = vi.fn();
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
        constructor() {
          super();
          socket = this;
          opens += 1;
        }
      } as unknown as typeof WebSocket,
    });

    connection.connect({ onBinaryOutput: binaryOutput, onBinaryFrame: binaryFrame, onError });
    socket?.dispatchEvent(new Event("open"));
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: encodeBinaryFrame({
          kind: "output",
          data: new Uint8Array([65, 66]),
        }).buffer,
      }),
    );
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: encodeBinaryFrame({
          kind: "snapshot",
          data: new Uint8Array([67]),
        }).buffer,
      }),
    );
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "unknown" }),
      }),
    );
    socket?.dispatchEvent(new Event("error"));
    expect(binaryOutput).toHaveBeenCalledWith(new Uint8Array([65, 66]));
    expect(binaryFrame).toHaveBeenNthCalledWith(1, {
      kind: "output",
      data: new Uint8Array([65, 66]),
    });
    expect(binaryFrame).toHaveBeenNthCalledWith(2, {
      kind: "snapshot",
      data: new Uint8Array([67]),
    });
    expect(onError).toHaveBeenCalled();

    connection.detach();
    vi.advanceTimersByTime(20);
    expect(opens).toBe(1);

    connection.connect({});
    socket?.dispatchEvent(new Event("open"));
    socket?.dispatchEvent(new Event("close"));
    (connection as unknown as { scheduleReconnect: () => void }).scheduleReconnect();
    connection.terminate();
    vi.advanceTimersByTime(20);
    expect(opens).toBe(3);
    vi.useRealTimers();
  });

  it("covers default constructor options and no-listener branches", () => {
    const originalWebSocket = globalThis.WebSocket;
    let socket: FakeSocket | null = null;

    globalThis.WebSocket = class extends FakeSocket {
      static readonly OPEN = 1;

      constructor(url: string) {
        super(url);
        socket = this;
      }
    } as unknown as typeof WebSocket;

    const connection = new TerminalConnection({
      url: "ws://localhost:8787/ws",
      auth: {
        token: "token",
        sessionId: "session-3",
        cols: 80,
        rows: 24,
      },
    });

    connection.detach();
    connection.terminate();
    connection.connect({});
    socket?.dispatchEvent(new Event("open"));
    connection.ping();
    socket?.dispatchEvent(new Event("close"));

    globalThis.WebSocket = originalWebSocket;
  });

  it("covers explicit open and close listeners", () => {
    let socket: FakeSocket | null = null;
    const onOpen = vi.fn();
    const onClose = vi.fn();

    const connection = new TerminalConnection({
      url: "ws://localhost:8787/ws",
      auth: {
        token: "token",
        sessionId: "session-4",
        cols: 80,
        rows: 24,
      },
      WebSocketImpl: class extends FakeSocket {
        constructor() {
          super();
          socket = this;
        }
      } as unknown as typeof WebSocket,
    });

    connection.connect({ onOpen, onClose });
    socket?.dispatchEvent(new Event("open"));
    connection.terminate();

    expect(onOpen).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
