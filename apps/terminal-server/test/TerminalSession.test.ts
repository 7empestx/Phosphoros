import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBinaryFrame } from "@terminal-platform/protocol";

import { TerminalSession } from "../src/session/TerminalSession.js";
import type { ServerConfig } from "../src/config.js";

type ExitHandler = (payload: { exitCode: number; signal: number }) => void | Promise<void>;

describe("TerminalSession", () => {
  const execFileAsync = vi.fn<(file: string, args: string[]) => Promise<unknown>>();
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();
  let onData: ((data: string) => void) | undefined;
  let onExit: ExitHandler | undefined;
  const spawnPty = vi.fn(() => ({
    write,
    resize,
    kill,
    onData(handler: (data: string) => void) {
      onData = handler;
    },
    onExit(handler: ExitHandler) {
      onExit = handler;
    },
  }));
  const socket = {
    send: vi.fn(),
    close: vi.fn(),
  };
  const otherSocket = {
    send: vi.fn(),
    close: vi.fn(),
  };
  const scheduled = new Map<number, () => void>();
  let timerId = 0;
  let now = 1_000;

  const setTimeoutImpl = vi.fn((callback: () => void) => {
    timerId += 1;
    scheduled.set(timerId, callback);
    return timerId as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutImpl = vi.fn((value: ReturnType<typeof setTimeout>) => {
    scheduled.delete(value as unknown as number);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    scheduled.clear();
    onData = undefined;
    onExit = undefined;
    timerId = 0;
    now = 1_000;
    execFileAsync.mockReset();
    execFileAsync.mockResolvedValue({});
  });

  it("attaches, replays, writes, resizes, detaches and expires", async () => {
    const session = new TerminalSession("session one", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    let result = await session.attach(socket as never, 120, 40);
    expect(execFileAsync).toHaveBeenCalledWith(config().tmuxPath, [
      "has-session",
      "-t",
      "terminal-session-one",
    ]);
    expect(result.snapshot).toEqual(Buffer.alloc(0));
    expect(session.getSnapshot().idleExpiresAt).toBeNull();

    onData?.("hello");
    await scheduled.get(1)?.();
    result = await session.attach(otherSocket as never, 100, 30);
    expect(socket.close).toHaveBeenCalledWith(1012, "Another client attached to this session");
    expect(kill).toHaveBeenCalled();
    expect(result.snapshot.toString("utf8")).toBe("hello");

    session.write("x");
    session.write("pwd\n");
    session.resize(90, 20);
    expect(write).toHaveBeenCalledWith("x");
    expect(write).toHaveBeenCalledWith("pwd\n");
    expect(resize).toHaveBeenCalledWith(90, 20);

    session.detach();
    expect(setTimeoutImpl).toHaveBeenCalled();
    expect(session.getSnapshot().connected).toBe(false);
    expect(session.getSnapshot().idleExpiresAt).not.toBeNull();
    now += 1_000;
    expect(session.isExpired(now)).toBe(true);
    expect(await session.disposeIfExpired()).toBe(true);
    expect(execFileAsync).toHaveBeenCalledWith(config().tmuxPath, [
      "kill-session",
      "-t",
      "terminal-session-one",
    ]);
    await scheduled.get(2)?.();
    expect(clearTimeoutImpl).toHaveBeenCalled();
  });

  it("creates tmux session when missing and handles transport exit with alive tmux", async () => {
    execFileAsync
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const session = new TerminalSession("needs create", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    await session.attach(socket as never, 80, 24);
    expect(execFileAsync).toHaveBeenNthCalledWith(2, config().tmuxPath, [
      "new-session",
      "-d",
      "-s",
      "terminal-needs-create",
      "-c",
      "/tmp",
      "/bin/zsh",
    ]);

    await onExit?.({ exitCode: 0, signal: 0 });
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining("\"type\":\"exit\""));
    expect(setTimeoutImpl).toHaveBeenCalled();
  });

  it("handles transport exit when tmux is gone and swallow kill errors", async () => {
    execFileAsync
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("gone"))
      .mockRejectedValueOnce(new Error("gone"));

    const session = new TerminalSession("gone", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    await session.attach(socket as never, 80, 24);
    await onExit?.({ exitCode: 1, signal: 9 });

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "exit",
        sessionId: "gone",
        exitCode: 1,
        signal: 9,
      }),
    );
    expect(socket.close).toHaveBeenCalled();

    await session.terminate();
    expect(execFileAsync).toHaveBeenLastCalledWith(config().tmuxPath, ["kill-session", "-t", "terminal-gone"]);
  });

  it("ignores exit events while the transport is intentionally closing", async () => {
    const session = new TerminalSession("closing", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    await session.attach(socket as never, 80, 24);
    session.detach();
    await onExit?.({ exitCode: 0, signal: 0 });

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("terminates from the scheduled idle timeout callback", async () => {
    const session = new TerminalSession("idle-timeout", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    await session.attach(socket as never, 80, 24);
    session.detach();
    await scheduled.get(1)?.();

    expect(execFileAsync).toHaveBeenCalledWith(config().tmuxPath, [
      "kill-session",
      "-t",
      "terminal-idle-timeout",
    ]);
  });



  it("preserves raw tmux session names when attaching by tmux-prefixed session id", () => {
    const session = new TerminalSession("tmux:shared", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    expect(session.getTmuxSessionName()).toBe("shared");
  });

  it("handles default deps, clean closes, and non-expired sessions", async () => {
    vi.resetModules();
    const mockedExecFile = vi
      .fn((file: string, args: string[], callback: (...data: any[]) => void) => {
        callback(null, "", "");
      })
      .mockImplementationOnce(
        (file: string, args: string[], callback: (...data: any[]) => void) => {
          callback(new Error("missing"), "", "");
        },
      );
    vi.doMock("node:child_process", () => ({
      execFile: mockedExecFile,
    }));

    let exitHandler: ExitHandler | undefined;
    const mockedSpawn = vi.fn(() => ({
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit(handler: ExitHandler) {
        exitHandler = handler;
      },
    }));
    vi.doMock("node-pty", () => ({
      spawn: mockedSpawn,
    }));

    const { TerminalSession: ImportedSession } = await import("../src/session/TerminalSession.js");
    const session = new ImportedSession("quoted'value", config());

    await session.attach(socket as never, 80, 24);
    expect(mockedExecFile).toHaveBeenCalled();
    expect(mockedSpawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/tmux",
      ["new-session", "-A", "-s", "terminal-quoted-value", "-c", "/tmp"],
      expect.anything(),
    );

    expect(await session.disposeIfExpired()).toBe(false);
    await exitHandler?.({ exitCode: 0, signal: 0 });
  });

  it("batches PTY output into framed binary payloads", async () => {
    const session = new TerminalSession("batched", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    await session.attach(socket as never, 80, 24);
    onData?.("hel");
    onData?.("lo");

    expect(socket.send).not.toHaveBeenCalled();
    await scheduled.get(1)?.();

    const frame = decodeBinaryFrame(socket.send.mock.calls[0][0]);
    expect(frame.kind).toBe("output");
    expect(Buffer.from(frame.data).toString("utf8")).toBe("hello");
    expect(socket.send.mock.calls[0][1]).toEqual({ binary: true });
  });

  it("covers no-transport, redundant resize, resize bursts, and dropped buffered output", async () => {
    const session = new TerminalSession("edge-cases", config(), {
      execFileAsync,
      spawnPty: spawnPty as never,
      now: () => now,
      setTimeoutImpl: setTimeoutImpl as never,
      clearTimeoutImpl: clearTimeoutImpl as never,
    });

    session.write("ls\n");

    await session.attach(socket as never, 80, 24);
    session.resize(80, 24);

    for (let index = 0; index < 7; index += 1) {
      session.resize(81 + index, 24);
    }

    onData?.("");
    onData?.("clear-before-flush");
    session.detach();
    expect(clearTimeoutImpl).toHaveBeenCalled();

    await session.attach(socket as never, 90, 24);
    onData?.("pending");
    (session as { socket: null }).socket = null;
    await scheduled.get(3)?.();

    expect(socket.send).not.toHaveBeenCalledWith(expect.any(Uint8Array), { binary: true });
    await session.terminate();
    session.write("pwd\n");
  });
});

function config(): ServerConfig {
  return {
    host: "0.0.0.0",
    port: 8787,
    websocketPath: "/ws",
    shellPath: "/bin/zsh",
    shellArgs: [],
    allowedShellPaths: ["/bin/zsh", "/bin/bash"],
    workingDirectory: "/tmp",
    allowedWorkingDirectories: ["/tmp"],
    replayBufferBytes: 1024,
    idleTtlMs: 500,
    tmuxPath: "/opt/homebrew/bin/tmux",
    authToken: "dev-token",
  };
}
