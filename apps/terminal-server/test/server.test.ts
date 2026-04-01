import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { encodeBinaryFrame, type ClientMessage } from "@terminal-platform/protocol";

import { createTerminalServer, handleMessage } from "../src/server.js";
import type { ServerConfig } from "../src/config.js";
import { SessionManager } from "../src/session/SessionManager.js";

describe("server helpers", () => {
  it("routes client messages", async () => {
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const sessionManager = {
      handleAuth: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const state = {
      sessionId: "session-1",
      onAuthed: vi.fn(),
    };

    const messages: ClientMessage[] = [
      { type: "auth", token: "dev-token", sessionId: "session-2", cols: 80, rows: 24 },
      { type: "input", data: "ls\n" },
      { type: "resize", cols: 100, rows: 40 },
      { type: "ping", ts: 123 },
      { type: "detach" },
      { type: "terminate" },
    ];

    for (const message of messages) {
      await handleMessage(socket as never, message, state, sessionManager as never);
    }

    expect(state.onAuthed).toHaveBeenCalledWith("session-2");
    expect(sessionManager.write).toHaveBeenCalledWith("session-1", "ls\n");
    expect(sessionManager.resize).toHaveBeenCalledWith("session-1", 100, 40);
    expect(sessionManager.detach).toHaveBeenCalledWith("session-1");
    expect(sessionManager.terminate).toHaveBeenCalledWith("session-1");
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "pong", ts: 123 }));
    expect(socket.close).toHaveBeenCalledWith(1000, "Terminated");
  });

  it("ignores unauthed input-like messages", async () => {
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const sessionManager = {
      handleAuth: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
      terminate: vi.fn(),
    };

    await handleMessage(
      socket as never,
      { type: "input", data: "ls\n" },
      { sessionId: null, onAuthed: vi.fn() },
      sessionManager as never,
    );

    expect(sessionManager.write).not.toHaveBeenCalled();
  });
});

describe("createTerminalServer", () => {
  let requestHandler: ((req: { url?: string }, res: any) => void) | undefined;
  const upgradeHandlers: Array<(request: any, socket: any, head: any) => void> = [];
  let connectionHandler: ((socket: any) => void) | undefined;

  beforeEach(() => {
    upgradeHandlers.length = 0;
    connectionHandler = undefined;
    vi.restoreAllMocks();
  });

  it("serves health checks, handles websocket flow, and shuts down", async () => {
    const server = {
      on: vi.fn((event: string, handler: (request: any, socket: any, head: any) => void) => {
        if (event === "upgrade") {
          upgradeHandlers.push(handler);
        }
      }),
      close: vi.fn((callback: () => void) => callback()),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    };
    const wsClients = new Set([{ close: vi.fn() }]);
    const ping = vi.fn();
    wsClients.add({ close: vi.fn(), readyState: WebSocket.OPEN, ping } as never);
    const websocketServer = {
      clients: wsClients,
      on: vi.fn((event: string, handler: (socket: any) => void) => {
        if (event === "connection") {
          connectionHandler = handler;
        }
      }),
      emit: vi.fn((_event: string, socket: any) => {
        connectionHandler?.(socket);
      }),
      handleUpgrade: vi.fn((request: any, _socket: any, _head: any, callback: (ws: any) => void) =>
        callback(fakeWs()),
      ),
    };
    const handleAuth = vi
      .spyOn(SessionManager.prototype, "handleAuth")
      .mockResolvedValue(undefined);
    const detach = vi.spyOn(SessionManager.prototype, "detach").mockImplementation(() => {});
    const writeToSession = vi.spyOn(SessionManager.prototype, "write").mockImplementation(() => {});
    const reapExpiredSessions = vi
      .spyOn(SessionManager.prototype, "reapExpiredSessions")
      .mockResolvedValue(undefined);
    const listAvailableSessions = vi
      .spyOn(SessionManager.prototype, "listAvailableSessions")
      .mockResolvedValue([]);
    const setIntervalImpl = vi.fn((callback: () => void) => {
      callback();
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalImpl = vi.fn();
    const processRef = {
      stdout: { write: vi.fn() },
      exit: vi.fn(),
      on: vi.fn(),
    };

    const { startTerminalServer } = await import("../src/server.js");

    const instance = createTerminalServer(config(), {
      createHttpServer: ((handler: typeof requestHandler) => {
        requestHandler = handler;
        return server as never;
      }) as never,
      WebSocketServerImpl: vi.fn(() => websocketServer) as never,
      setIntervalImpl: setIntervalImpl as never,
      clearIntervalImpl: clearIntervalImpl as never,
      processRef: processRef as never,
    });

    const response = fakeResponse();
    requestHandler?.({ url: "/healthz" }, response);
    expect(response.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });

    const missingResponse = fakeResponse();
    requestHandler?.({ url: "/missing", method: "GET" }, missingResponse);
    expect(missingResponse.writeHead).toHaveBeenCalledWith(404, {
      "content-type": "application/json",
    });

    const nullUrlResponse = fakeResponse();
    requestHandler?.({ method: "POST" }, nullUrlResponse);
    expect(nullUrlResponse.writeHead).toHaveBeenCalledWith(404, {
      "content-type": "application/json",
    });

    const noMethodResponse = fakeResponse();
    requestHandler?.({ url: "/missing-no-method" }, noMethodResponse);
    expect(noMethodResponse.writeHead).toHaveBeenCalledWith(404, {
      "content-type": "application/json",
    });

    const sessionsResponse = fakeResponse();
    requestHandler?.({ url: "/sessions", method: "GET" }, sessionsResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionsResponse.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "application/json",
    });
    expect(sessionsResponse.end).toHaveBeenCalledWith(JSON.stringify({ sessions: [] }));
    expect(listAvailableSessions).toHaveBeenCalled();

    const upgradeSocket = { destroy: vi.fn() };
    upgradeHandlers[0]?.(
      { headers: { host: "localhost:8787" } },
      upgradeSocket,
      Buffer.alloc(0),
    );
    expect(upgradeSocket.destroy).toHaveBeenCalled();

    upgradeHandlers[0]?.(
      {
        url: "/ws",
        headers: { host: "localhost:8787" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      { destroy: vi.fn() },
      Buffer.alloc(0),
    );
    upgradeHandlers[0]?.(
      {
        url: "/ws",
        headers: { host: "localhost:8787" },
      },
      { destroy: vi.fn() },
      Buffer.alloc(0),
    );
    const ws = fakeWs();
    connectionHandler?.(ws);
    await ws.handlers.message?.(
      {
        toString() {
          throw "boom";
        },
      },
      false,
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "error",
        code: "BAD_MESSAGE",
        message: "Failed to parse message",
      }),
    );
    await ws.handlers.message?.(
      {
        toString() {
          throw new Error("bad");
        },
      },
      false,
    );
    await ws.handlers.message?.(Buffer.from("ignored"), true);
    await ws.handlers.message?.(
      Buffer.from(
        JSON.stringify({
          type: "auth",
          token: "dev-token",
          sessionId: "session-1",
          cols: 80,
          rows: 24,
        }),
      ),
      false,
    );
    await ws.handlers.message?.(
      encodeBinaryFrame({
        kind: "input",
        data: new TextEncoder().encode("pwd\n"),
      }),
      true,
    );
    ws.handlers.close?.();

    expect(handleAuth).toHaveBeenCalled();
    expect(writeToSession).toHaveBeenCalledWith("session-1", "pwd\n");
    expect(detach).toHaveBeenCalledWith("session-1");
    expect(reapExpiredSessions).toHaveBeenCalled();
    expect(ping).toHaveBeenCalled();

    startTerminalServer(config(), {
      createHttpServer: ((handler: typeof requestHandler) => {
        requestHandler = handler;
        return server as never;
      }) as never,
      WebSocketServerImpl: vi.fn(() => websocketServer) as never,
      setIntervalImpl: setIntervalImpl as never,
      clearIntervalImpl: clearIntervalImpl as never,
      processRef: processRef as never,
    });
    expect(server.listen).toHaveBeenCalled();
    expect(processRef.stdout.write).toHaveBeenCalled();

    instance.shutdown();
    expect(clearIntervalImpl).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
  });
});

function config(): ServerConfig {
  return {
    host: "0.0.0.0",
    port: 8787,
    websocketPath: "/ws",
    shellPath: "/bin/zsh",
    shellArgs: [],
    allowedShellPaths: ["/bin/zsh"],
    workingDirectory: "/tmp",
    allowedWorkingDirectories: ["/tmp"],
    replayBufferBytes: 1024,
    idleTtlMs: 1_000,
    tmuxPath: "/opt/homebrew/bin/tmux",
    authToken: "dev-token",
  };
}

function fakeResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function fakeWs() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  return {
    handlers,
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      handlers[event] = handler;
    }),
    send: vi.fn(),
    close: vi.fn(),
  };
}
