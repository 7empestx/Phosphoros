import { describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../src/config.js";

describe("server default dependencies", () => {
  it("uses built-in defaults when deps are omitted", async () => {
    vi.resetModules();

    const server = {
      on: vi.fn(),
      close: vi.fn((callback: () => void) => callback()),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    };
    const createServer = vi.fn(() => server);

    const websocketServer = {
      clients: new Set(),
      on: vi.fn(),
      emit: vi.fn(),
      handleUpgrade: vi.fn(),
    };
    const WebSocketServerImpl = vi.fn(() => websocketServer);

    vi.doMock("node:http", () => ({
      default: { createServer },
      createServer,
    }));
    vi.doMock("ws", () => ({
      default: class {},
      WebSocketServer: WebSocketServerImpl,
    }));
    vi.doMock("node-pty", () => ({
      spawn: vi.fn(),
    }));

    const processRef = {
      stdout: { write: vi.fn() },
      exit: vi.fn(),
      on: vi.fn(),
    };
    vi.stubGlobal("process", processRef);

    const { createTerminalServer, startTerminalServer } = await import("../src/server.js");

    createTerminalServer(config());
    startTerminalServer(config());

    expect(createServer).toHaveBeenCalled();
    expect(WebSocketServerImpl).toHaveBeenCalledWith({ noServer: true });
    expect(processRef.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.stdout.write).toHaveBeenCalled();
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
