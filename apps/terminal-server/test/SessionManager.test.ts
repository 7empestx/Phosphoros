import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBinaryFrame } from "@terminal-platform/protocol";

import type { ServerConfig } from "../src/config.js";

const sessionState = {
  attach: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  detach: vi.fn(),
  terminate: vi.fn(),
  disposeIfExpired: vi.fn(),
};

vi.mock("../src/session/TerminalSession.js", () => {
  return {
    TerminalSession: vi.fn().mockImplementation((sessionId: string) => ({
      sessionId,
      attach: sessionState.attach,
      getSnapshot: vi.fn(() => ({
        sessionId,
        cols: 80,
        rows: 24,
        connected: true,
        durable: true,
        idleExpiresAt: null,
      })),
      getTmuxSessionName: vi.fn(() =>
        sessionId.startsWith("tmux:") ? sessionId.slice("tmux:".length) : `terminal-${sessionId}`,
      ),
      write: sessionState.write,
      resize: sessionState.resize,
      detach: sessionState.detach,
      terminate: sessionState.terminate,
      disposeIfExpired: sessionState.disposeIfExpired,
    })),
  };
});

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.attach.mockResolvedValue({ snapshot: Buffer.from("snapshot") });
    sessionState.disposeIfExpired.mockResolvedValue(false);
  });

  it("authenticates and emits ready/session/snapshot", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const manager = new SessionManager(config());
    const socket = fakeSocket();

    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-1",
      cols: 80,
      rows: 24,
    });

    expect(sessionState.attach).toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(3);
    expect(decodeBinaryFrame(socket.send.mock.calls[2][0]).kind).toBe("snapshot");
  });

  it("trims oversized replay snapshots before sending to the client", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const manager = new SessionManager(config());
    const socket = fakeSocket();
    sessionState.attach.mockResolvedValue({
      snapshot: Buffer.from("a".repeat(300 * 1024)),
    });

    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-big",
      cols: 80,
      rows: 24,
    });

    const frame = decodeBinaryFrame(socket.send.mock.calls[2][0]);
    expect(frame.kind).toBe("snapshot");
    expect(frame.data.byteLength).toBe(256 * 1024);
  });

  it("rejects invalid auth and manages lifecycle methods", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const manager = new SessionManager(config());
    const socket = fakeSocket();

    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "bad-token",
      sessionId: "session-1",
      cols: 80,
      rows: 24,
    });

    expect(socket.close).toHaveBeenCalledWith(4001, "Authentication failed");

    manager.write("missing", "pwd\n");
    manager.resize("missing", 10, 10);
    manager.detach("missing");
    await manager.terminate("missing");
  });

  it("reuses sessions, skips empty snapshots, terminates and reaps expired", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const manager = new SessionManager(config(), {
      execFileAsync: vi.fn().mockResolvedValue({ stdout: "" }),
    });
    const socket = fakeSocket();
    sessionState.attach.mockResolvedValueOnce({ snapshot: Buffer.alloc(0) }).mockResolvedValueOnce({
      snapshot: Buffer.alloc(0),
    });
    sessionState.disposeIfExpired.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-1",
      cols: 80,
      rows: 24,
    });
    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-1",
      cols: 81,
      rows: 25,
    });
    expect(manager.listSessions()).toEqual([
      {
        type: "session_status",
        sessionId: "session-1",
        cols: 80,
        rows: 24,
        connected: true,
        durable: true,
        idleExpiresAt: null,
      },
    ]);
    expect(await manager.listAvailableSessions()).toEqual([
      {
        sessionId: "session-1",
        tmuxSessionName: "terminal-session-1",
        cols: 80,
        rows: 24,
        connected: true,
        durable: true,
        idleExpiresAt: null,
        source: "memory",
      },
    ]);

    manager.write("session-1", "pwd\n");
    manager.resize("session-1", 100, 50);
    manager.detach("session-1");
    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-2",
      cols: 82,
      rows: 26,
    });
    await manager.reapExpiredSessions();
    await manager.terminate("session-1");

    expect(sessionState.write).toHaveBeenCalledWith("pwd\n");
    expect(sessionState.resize).toHaveBeenCalledWith(100, 50);
    expect(sessionState.detach).toHaveBeenCalled();
    expect(sessionState.terminate).toHaveBeenCalled();
    expect(await manager.listAvailableSessions()).toEqual([]);
  });

  it("enumerates every tmux session on the machine and merges memory sessions", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const execFileAsync = vi.fn().mockResolvedValue({
      stdout: "terminal-session-1\nproject-shell\nshared\n",
    });
    const manager = new SessionManager(config(), { execFileAsync });
    const socket = fakeSocket();
    sessionState.attach.mockResolvedValue({ snapshot: Buffer.alloc(0) });

    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-1",
      cols: 80,
      rows: 24,
    });

    await expect(manager.listAvailableSessions()).resolves.toEqual([
      {
        sessionId: "tmux:project-shell",
        tmuxSessionName: "project-shell",
        cols: null,
        rows: null,
        connected: false,
        durable: true,
        idleExpiresAt: null,
        source: "tmux",
      },
      {
        sessionId: "tmux:shared",
        tmuxSessionName: "shared",
        cols: null,
        rows: null,
        connected: false,
        durable: true,
        idleExpiresAt: null,
        source: "tmux",
      },
      {
        sessionId: "session-1",
        tmuxSessionName: "terminal-session-1",
        cols: 80,
        rows: 24,
        connected: true,
        durable: true,
        idleExpiresAt: null,
        source: "memory",
      },
    ]);
  });



  it("uses the default tmux enumerator and exposes in-memory session snapshots", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const manager = new SessionManager(config());

    expect(manager.listSessions()).toEqual([]);
    await expect(manager.listAvailableSessions()).resolves.toEqual(expect.any(Array));
  });

  it("falls back to memory sessions when tmux enumeration fails", async () => {
    const { SessionManager } = await import("../src/session/SessionManager.js");
    const manager = new SessionManager(config(), {
      execFileAsync: vi.fn().mockRejectedValue("tmux down"),
    });
    const socket = fakeSocket();
    sessionState.attach.mockResolvedValue({ snapshot: Buffer.alloc(0) });

    await manager.handleAuth(socket as never, {
      type: "auth",
      token: "dev-token",
      sessionId: "session-1",
      cols: 80,
      rows: 24,
    });

    await expect(manager.listAvailableSessions()).resolves.toEqual([
      {
        sessionId: "session-1",
        tmuxSessionName: "terminal-session-1",
        cols: 80,
        rows: 24,
        connected: true,
        durable: true,
        idleExpiresAt: null,
        source: "memory",
      },
    ]);
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

function fakeSocket() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}
