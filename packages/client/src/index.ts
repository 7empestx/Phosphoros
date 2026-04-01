import type {
  AuthMessage,
  BinaryFrame,
  ClientMessage,
  ServerMessage,
} from "@terminal-platform/protocol";
import {
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  isServerMessage,
  serializeServerMessage,
} from "@terminal-platform/protocol";

export interface TerminalConnectionOptions {
  url: string;
  auth: Omit<AuthMessage, "type">;
  reconnectDelayMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

export interface TerminalConnectionEvents {
  onOpen?: () => void;
  onClose?: (event: CloseEvent | Event) => void;
  onError?: (event: Event) => void;
  onMessage?: (message: ServerMessage) => void;
  onBinaryOutput?: (data: Uint8Array) => void;
  onBinaryFrame?: (frame: BinaryFrame) => void;
}

export class TerminalConnection {
  private readonly reconnectDelayMs: number;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly auth: Omit<AuthMessage, "type">;
  private readonly url: string;
  private readonly listeners: TerminalConnectionEvents = {};
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByClient = false;

  constructor(options: TerminalConnectionOptions) {
    this.url = options.url;
    this.auth = options.auth;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect(events: TerminalConnectionEvents): void {
    Object.assign(this.listeners, events);
    this.closedByClient = false;
    this.openSocket();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  sendInput(data: string): void {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) {
      return;
    }
    this.socket.send(encodeBinaryFrame({ kind: "input", data: new TextEncoder().encode(data) }));
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  ping(ts = Date.now()): void {
    this.send({ type: "ping", ts });
  }

  detach(): void {
    this.closedByClient = true;
    this.send({ type: "detach" });
    this.socket?.close();
  }

  terminate(): void {
    this.closedByClient = true;
    this.send({ type: "terminate" });
    this.socket?.close();
  }

  private openSocket(): void {
    const socket = new this.WebSocketImpl(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          ...this.auth,
        } satisfies AuthMessage),
      );
      this.listeners.onOpen?.();
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const parsed = JSON.parse(event.data) as unknown;
        if (isServerMessage(parsed)) {
          this.listeners.onMessage?.(parsed);
        }
        return;
      }

      const array =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array();
      try {
        const frame = decodeBinaryFrame(array);
        this.listeners.onBinaryFrame?.(frame);
        if (frame.kind === "output") {
          this.listeners.onBinaryOutput?.(frame.data);
        }
      } catch {
        this.listeners.onError?.(new Event("error"));
      }
    });

    socket.addEventListener("error", (event) => {
      this.listeners.onError?.(event);
    });

    socket.addEventListener("close", (event) => {
      this.listeners.onClose?.(event);
      this.socket = null;
      if (!this.closedByClient) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, this.reconnectDelayMs);
  }
}

export { PROTOCOL_VERSION, isServerMessage, serializeServerMessage };
