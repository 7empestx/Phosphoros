import type http from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import type { ClientMessage } from "@terminal-platform/protocol";
import { decodeBinaryFrame, parseClientMessage } from "@terminal-platform/protocol";

import type { ServerConfig } from "./config.js";
import { log } from "./logger.js";
import type { SessionManager } from "./session/SessionManager.js";

const textDecoder = new TextDecoder();

export interface TerminalServerState {
  sessionId: string | null;
  onAuthed: (sessionId: string) => void;
}

export async function handleMessage(
  socket: Pick<WebSocket, "send" | "close">,
  message: ClientMessage,
  state: TerminalServerState,
  sessionManager: Pick<
    SessionManager,
    "handleAuth" | "write" | "resize" | "detach" | "terminate"
  >,
): Promise<void> {
  log("info", "Received websocket message", describeClientMessage(message, state.sessionId));

  switch (message.type) {
    case "auth":
      state.onAuthed(message.sessionId);
      await sessionManager.handleAuth(socket as WebSocket, message);
      return;
    case "input":
      if (state.sessionId) {
        sessionManager.write(state.sessionId, message.data);
      }
      return;
    case "resize":
      if (state.sessionId) {
        sessionManager.resize(state.sessionId, message.cols, message.rows);
      }
      return;
    case "ping":
      socket.send(JSON.stringify({ type: "pong", ts: message.ts }));
      return;
    case "detach":
      if (state.sessionId) {
        sessionManager.detach(state.sessionId);
      }
      socket.close(1000, "Detached");
      return;
    case "terminate":
      if (state.sessionId) {
        await sessionManager.terminate(state.sessionId);
      }
      socket.close(1000, "Terminated");
      return;
  }
}

export function createUpgradeHandler(
  config: ServerConfig,
  websocketServer: Pick<WebSocketServer, "handleUpgrade" | "emit">,
): (request: http.IncomingMessage, socket: any, head: Buffer) => void {
  return (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname !== config.websocketPath) {
      log("warn", "Rejected websocket upgrade for unexpected path", {
        path: url.pathname,
        expectedPath: config.websocketPath,
      });
      socket.destroy();
      return;
    }

    log("info", "Handling websocket upgrade", {
      path: url.pathname,
      remoteAddress: request.socket?.remoteAddress ?? null,
    });
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit("connection", ws, request);
    });
  };
}

export function createConnectionHandler(
  sessionManager: Pick<
    SessionManager,
    "handleAuth" | "write" | "resize" | "detach" | "terminate"
  >,
): (socket: WebSocket) => void {
  return (socket) => {
    let sessionId: string | null = null;
    log("info", "Websocket client connected");

    socket.on("message", async (payload, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload as ArrayBuffer);
        try {
          const frame = decodeBinaryFrame(
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          );
          if (frame.kind === "input" && sessionId) {
            const data = textDecoder.decode(frame.data);
            log("info", "Received binary terminal input", {
              sessionId,
              bytes: frame.data.byteLength,
              preview: previewInput(data),
              endsWithNewline: /[\r\n]$/.test(data),
            });
            sessionManager.write(sessionId, data);
          }
        } catch {
          log("warn", "Ignoring malformed binary message from client", { sessionId });
        }
        return;
      }

      try {
        const message = parseClientMessage(payload.toString());
        await handleMessage(
          socket,
          message,
          {
            onAuthed(id) {
              sessionId = id;
            },
            sessionId,
          },
          sessionManager,
        );
      } catch (error) {
        log("error", "Failed to process websocket message", {
          sessionId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        socket.send(
          JSON.stringify({
            type: "error",
            code: "BAD_MESSAGE",
            message: error instanceof Error ? error.message : "Failed to parse message",
          }),
        );
      }
    });

    socket.on("close", () => {
      log("info", "Websocket client disconnected", { sessionId });
      if (sessionId) {
        sessionManager.detach(sessionId);
      }
    });
  };
}

function describeClientMessage(
  message: ClientMessage,
  sessionId: string | null,
): Record<string, unknown> {
  switch (message.type) {
    case "auth":
      return {
        type: message.type,
        sessionId,
        requestedSessionId: message.sessionId,
        cols: message.cols,
        rows: message.rows,
      };
    case "input":
      return {
        type: message.type,
        sessionId,
        bytes: Buffer.byteLength(message.data),
        preview: previewInput(message.data),
        endsWithNewline: /[\r\n]$/.test(message.data),
      };
    case "resize":
      return {
        type: message.type,
        sessionId,
        cols: message.cols,
        rows: message.rows,
      };
    case "ping":
      return {
        type: message.type,
        sessionId,
        ts: message.ts,
      };
    case "detach":
    case "terminate":
      return {
        type: message.type,
        sessionId,
      };
  }
}

function previewInput(data: string): string {
  return data.replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, 80);
}
