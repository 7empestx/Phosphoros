import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BinaryFrame, ServerMessage } from "@terminal-platform/protocol";

const terminalState = {
  writes: [] as string[],
  onDataHandler: undefined as ((data: string) => void) | undefined,
  opened: undefined as Element | undefined,
  resized: [] as Array<[number, number]>,
};

const connectionState = {
  instance: null as null | FakeConnection,
};
const animationFrames = new Map<number, FrameRequestCallback>();
const timeouts = new Map<number, () => void>();
let nextFrameId = 0;
let nextTimeoutId = 0;
let storage: Storage;

function okFetch(payload: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  });
}

class FakeTerminal {
  element?: Element;

  open(element: Element): void {
    terminalState.opened = element;
    this.element = element;
  }

  resize(cols: number, rows: number): void {
    terminalState.resized.push([cols, rows]);
  }

  onData(handler: (data: string) => void): void {
    terminalState.onDataHandler = handler;
  }

  write(data: string): void {
    terminalState.writes.push(data);
  }

  loadAddon(addon: { activate: (terminal: FakeTerminal) => void }): void {
    addon.activate(this);
  }
}

class FakeConnection {
  events: Record<string, any> = {};
  sentInput: string[] = [];
  resizeCalls: Array<[number, number]> = [];

  constructor(public readonly options: Record<string, any>) {
    connectionState.instance = this;
  }

  connect(events: Record<string, any>): void {
    this.events = events;
  }

  sendInput(data: string): void {
    this.sentInput.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push([cols, rows]);
  }
}

const init = vi.fn().mockResolvedValue(undefined);

class FakeFitAddon {
  private terminal?: FakeTerminal;

  activate(terminal: FakeTerminal): void {
    this.terminal = terminal;
  }

  dispose(): void {}

  proposeDimensions(): { cols: number; rows: number } | undefined {
    const element = this.terminal?.element as HTMLElement | undefined;
    if (element?.ownerDocument.body.dataset.forceFitFallback === "true") {
      return undefined;
    }

    if (!element?.clientWidth || !element?.clientHeight) {
      return undefined;
    }

    return {
      cols: Math.max(2, Math.floor((element.clientWidth - 12) / 8) - 1),
      rows: Math.max(1, Math.floor(element.clientHeight / 17)),
    };
  }
}

vi.mock("ghostty-web", () => ({
  init,
  Terminal: FakeTerminal,
  FitAddon: FakeFitAddon,
}));

vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({
  default: "/ghostty-vt.wasm",
}));

vi.mock("@terminal-platform/client", () => ({
  TerminalConnection: FakeConnection,
}));

describe("web app", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id=\"app\"></div>";
    storage = createStorage();
    animationFrames.clear();
    timeouts.clear();
    nextFrameId = 0;
    nextTimeoutId = 0;
    terminalState.writes = [];
    terminalState.onDataHandler = undefined;
    terminalState.opened = undefined;
    terminalState.resized = [];
    connectionState.instance = null;
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("mounts, wires terminal IO, and handles UI events", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "localhost", reload },
      configurable: true,
    });
    class FakeResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        this.callback();
      }
      disconnect(): void {}
    }
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1;
      animationFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelAnimationFrame = vi.fn((id: number) => {
      animationFrames.delete(id);
    });
    const setTimeout = vi.fn((callback: () => void) => {
      nextTimeoutId += 1;
      timeouts.set(nextTimeoutId, callback);
      return nextTimeoutId;
    });
    const clearTimeout = vi.fn((id: number) => {
      timeouts.delete(id);
    });

    const { mountTerminalApp } = await import("../src/app.js");
    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-1" } as Crypto,
      fetch: okFetch({ sessions: [] }) as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: requestAnimationFrame as never,
      cancelAnimationFrame: cancelAnimationFrame as never,
      setTimeout: setTimeout as never,
      clearTimeout: clearTimeout as never,
    });

    expect(init).toHaveBeenCalled();
    expect(terminalState.opened).toBe(document.querySelector("#terminal"));
    expect(terminalState.resized).toContainEqual([120, 34]);
    expect(document.querySelector("#session-id")?.textContent).toBe("session-1");
    expect(console.info).toHaveBeenCalledWith(
      "[browser-terminal] Created browser terminal session",
      { sessionId: "session-1" },
    );
    flushAllTimeouts();
    await Promise.resolve();

    terminalState.onDataHandler?.("pwd\n");
    expect(connectionState.instance?.sentInput).toEqual(["pwd\n"]);
    expect(connectionState.instance?.resizeCalls).toEqual([]);

    connectionState.instance?.events.onOpen();
    expect(document.querySelector("#status-text")?.textContent).toBe("Connected");
    expect(console.info).toHaveBeenCalledWith(
      "[browser-terminal] Connected browser terminal session",
      { sessionId: "session-1" },
    );

    connectionState.instance?.events.onBinaryFrame({
      kind: "output",
      data: new Uint8Array([65]),
    } satisfies BinaryFrame);
    expect(terminalState.writes).toEqual([]);
    flushAllAnimationFrames();
    expect(terminalState.writes).toContain("A");

    const messages: ServerMessage[] = [
      { type: "ready", sessionId: "session-1", protocolVersion: 1, reconnectable: true },
      { type: "snapshot", data: "snap" },
      {
        type: "session_status",
        sessionId: "session-1",
        connected: true,
        durable: true,
        cols: 80,
        rows: 24,
        idleExpiresAt: null,
      },
      { type: "session_status", sessionId: "session-1", connected: false, durable: true, cols: 80, rows: 24, idleExpiresAt: null },
      { type: "error", code: "BAD", message: "Oops" },
      { type: "exit", sessionId: "session-1", exitCode: 0, signal: null },
      { type: "pong", ts: 1 },
      { type: "output", data: "live" },
    ];

    for (const message of messages) {
      connectionState.instance?.events.onMessage(message);
    }
    flushAllAnimationFrames();

    expect(terminalState.writes.join("")).toContain("snap");
    expect(terminalState.writes.join("")).toContain("live");

    connectionState.instance?.events.onClose();
    expect(document.querySelector("#status-text")?.textContent).toBe("Reconnecting...");
    expect(console.warn).toHaveBeenCalledWith(
      "[browser-terminal] Browser terminal connection closed",
      { sessionId: "session-1" },
    );

    connectionState.instance?.events.onError();
    expect(document.querySelector("#status-text")?.textContent).toBe("Connection error");
    expect(console.error).toHaveBeenCalledWith(
      "[browser-terminal] Browser terminal connection error",
      { sessionId: "session-1" },
    );

    document.querySelector<HTMLButtonElement>("#attach-session")?.click();
    expect(reload).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>("#reset-session")?.click();
    expect(storage.getItem("terminal-platform.session-id")).toBeNull();
    expect(reload).toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      "[browser-terminal] Resetting browser terminal session",
      { sessionId: "session-1" },
    );
  });

  it("reuses the stored session id across reloads", async () => {
    storage.setItem("terminal-platform.session-id", "existing-session");
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "localhost", reload: vi.fn() },
      configurable: true,
    });

    class FakeResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        this.callback();
      }
      disconnect(): void {}
    }

    const { mountTerminalApp } = await import("../src/app.js");
    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "unused-session" } as Crypto,
      fetch: okFetch({
        sessions: [
          {
            sessionId: "existing-session",
            tmuxSessionName: "terminal-existing-session",
            cols: 80,
            rows: 24,
            connected: true,
            durable: true,
            idleExpiresAt: null,
            source: "memory",
          },
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
        ],
      }) as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: ((callback: () => void) => {
        nextTimeoutId += 1;
        timeouts.set(nextTimeoutId, callback);
        return nextTimeoutId;
      }) as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });

    expect(document.querySelector("#session-id")?.textContent).toBe("existing-session");
    expect(connectionState.instance?.options.auth.sessionId).toBe("existing-session");
    await Promise.resolve();
    const options = Array.from(document.querySelectorAll("#session-select option")).map((option) =>
      option.textContent,
    );
    expect(options).toContain("Current: existing");
    expect(options).toContain("project-shell · tmux");
    expect(console.info).toHaveBeenCalledWith(
      "[browser-terminal] Reusing stored browser terminal session",
      { sessionId: "existing-session" },
    );
  });

  it("sends one post-mount resize when the terminal fit changes", async () => {
    document.body.innerHTML =
      "<div id=\"app\"></div><div id=\"test-width\" style=\"width: 800px;height: 600px\"></div>";

    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "localhost", reload: vi.fn() },
      configurable: true,
    });

    class FakeResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        const terminal = document.querySelector<HTMLElement>("#terminal");
        if (terminal) {
          Object.defineProperty(terminal, "clientWidth", {
            value: 800,
            configurable: true,
          });
          Object.defineProperty(terminal, "clientHeight", {
            value: 600,
            configurable: true,
          });
        }
        this.callback();
      }
      disconnect(): void {}
    }

    const setTimeout = vi.fn((callback: () => void) => {
      nextTimeoutId += 1;
      timeouts.set(nextTimeoutId, callback);
      return nextTimeoutId;
    });

    const { mountTerminalApp } = await import("../src/app.js");
    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-2" } as Crypto,
      fetch: okFetch({ sessions: [] }) as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: setTimeout as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });

    flushAllTimeouts();

    expect(connectionState.instance?.resizeCalls).toHaveLength(1);
    expect(connectionState.instance?.resizeCalls[0]).toEqual([97, 35]);
  });

  it("falls back to manual fit sizing when the fit addon cannot propose dimensions", async () => {
    document.body.dataset.forceFitFallback = "true";
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "localhost", reload: vi.fn() },
      configurable: true,
    });

    class FakeResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        const terminal = document.querySelector<HTMLElement>("#terminal");
        if (terminal) {
          Object.defineProperty(terminal, "clientWidth", {
            value: 800,
            configurable: true,
          });
          Object.defineProperty(terminal, "clientHeight", {
            value: 600,
            configurable: true,
          });
        }
        this.callback();
      }
      disconnect(): void {}
    }

    const setTimeout = vi.fn((callback: () => void) => {
      nextTimeoutId += 1;
      timeouts.set(nextTimeoutId, callback);
      return nextTimeoutId;
    });

    const { mountTerminalApp } = await import("../src/app.js");
    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-3" } as Crypto,
      fetch: okFetch({ sessions: [] }) as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: setTimeout as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });

    flushAllTimeouts();

    expect(terminalState.resized).toContainEqual([120, 34]);
    expect(connectionState.instance?.resizeCalls).toEqual([[97, 35]]);
    delete document.body.dataset.forceFitFallback;
  });

  it("covers helpers and missing app root", async () => {
    const module = await import("../src/app.js");
    const statusText = document.createElement("span");
    const statusDot = document.createElement("span");
    const inspectorText = document.createElement("span");
    const inspectorDot = document.createElement("span");
    const terminal = new FakeTerminal() as never;
    const writer = new module.TerminalWriteBuffer(terminal, {
      requestAnimationFrame(callback: FrameRequestCallback) {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      },
      cancelAnimationFrame(id: number) {
        animationFrames.delete(id);
      },
    });

    module.setStatus(statusText, statusDot, "idle", "Done");
    expect(statusText.textContent).toBe("Done");
    expect(statusDot.dataset.state).toBe("idle");

    storage.setItem(module.SESSION_STORAGE_KEY, "existing");
    expect(module.getOrCreateSessionId(storage, crypto)).toBe("existing");
    storage.removeItem(module.SESSION_STORAGE_KEY);
    expect(
      module.getOrCreateSessionId(storage, { randomUUID: () => "generated-session" } as Crypto),
    ).toBe("generated-session");
    expect(
      module.createFreshSessionId(storage, { randomUUID: () => "fresh-session" } as Crypto),
    ).toBe("fresh-session");
    expect(storage.getItem(module.SESSION_STORAGE_KEY)).toBe("fresh-session");
    expect(module.toWebSocketUrl(new URL("https://example.com") as never, 8787, "/ws")).toBe(
      "wss://example.com:8787/ws",
    );
    expect(module.toHttpUrl(new URL("https://example.com") as never, 8787, "/sessions")).toBe(
      "https://example.com:8787/sessions",
    );

    module.handleMessage(
      writer,
      { type: "error", code: "NOPE", message: "bad" },
      [
        { text: statusText, dot: statusDot },
        { text: inspectorText, dot: inspectorDot },
      ],
    );
    expect(statusText.textContent).toContain("NOPE");
    expect(inspectorText.textContent).toContain("NOPE");
    module.setStatusViews(
      [
        { text: statusText, dot: statusDot },
        { text: inspectorText, dot: inspectorDot },
      ],
      "connected",
      ["Connected", "CONNECTED"],
    );
    expect(statusText.textContent).toBe("Connected");
    expect(inspectorText.textContent).toBe("CONNECTED");
    module.setStatusViews(
      [
        { text: statusText, dot: statusDot },
        { text: inspectorText, dot: inspectorDot },
      ],
      "idle",
      ["Shared"],
    );
    expect(statusText.textContent).toBe("Shared");
    expect(inspectorText.textContent).toBe("Shared");
    module.setStatusViews([{ text: statusText, dot: statusDot }], "idle", []);
    expect(statusText.textContent).toBe("");
    const select = document.createElement("select");
    module.syncSessionSelectOptions(
      select,
      [
        {
          sessionId: "alpha-session",
          tmuxSessionName: "terminal-alpha-session",
          cols: 80,
          rows: 24,
          connected: true,
          durable: true,
          idleExpiresAt: null,
          source: "memory",
        },
        {
          sessionId: "tmux:beta-session",
          tmuxSessionName: "beta-session",
          cols: null,
          rows: null,
          connected: false,
          durable: true,
          idleExpiresAt: null,
          source: "tmux",
        },
      ],
      "current-session",
    );
    expect(select.options).toHaveLength(3);
    expect(select.value).toBe("current-session");
    expect(select.options[1]?.textContent).toContain("terminal-alpha-session · 80x24 · attached");
    expect(select.options[2]?.textContent).toContain("beta-session · tmux");
    module.handleBinaryFrame(writer, {
      kind: "snapshot",
      data: new Uint8Array([66]),
    });
    flushAllAnimationFrames();
    expect(terminalState.writes).toContain("B");
    writer.clear();

    const overloadWriter = new module.TerminalWriteBuffer(terminal, {
      requestAnimationFrame(callback: FrameRequestCallback) {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      },
      cancelAnimationFrame(id: number) {
        animationFrames.delete(id);
      },
    });
    overloadWriter.write("x".repeat(600 * 1024));
    expect(overloadWriter.isPaused).toBe(true);
    expect(overloadWriter.droppedOutputBytes).toBeGreaterThan(0);
    expect(terminalState.writes.join("")).toContain("Output paused");
    overloadWriter.write("");

    const emptyWriter = new module.TerminalWriteBuffer(terminal, {
      requestAnimationFrame(callback: FrameRequestCallback) {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      },
      cancelAnimationFrame(id: number) {
        animationFrames.delete(id);
      },
    });
    emptyWriter.flush();

    const chunkedWriter = new module.TerminalWriteBuffer(terminal, {
      requestAnimationFrame(callback: FrameRequestCallback) {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      },
      cancelAnimationFrame(id: number) {
        animationFrames.delete(id);
      },
    });
    const largePayload = "y".repeat(140 * 1024);
    chunkedWriter.write(largePayload);
    flushAllAnimationFrames();
    expect(terminalState.writes.some((value) => value.length < largePayload.length)).toBe(true);

    const clearableWriter = new module.TerminalWriteBuffer(terminal, {
      requestAnimationFrame(callback: FrameRequestCallback) {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      },
      cancelAnimationFrame(id: number) {
        animationFrames.delete(id);
      },
    });
    clearableWriter.write("queued");
    clearableWriter.clear();
    flushAllAnimationFrames();
    expect(terminalState.writes).not.toContain("queued");

    document.body.innerHTML = "";
    await expect(module.mountTerminalApp()).rejects.toThrow("App root not found");

    const fakeDocument = {
      querySelector: vi
        .fn()
        .mockReturnValueOnce({
          innerHTML: "",
        })
        .mockReturnValue(null),
    } as unknown as Document;

    await expect(
      module.mountTerminalApp({
        document: fakeDocument,
        location: {
          protocol: "http:",
          hostname: "localhost",
          reload: vi.fn(),
        } as unknown as Location,
        localStorage: storage,
        crypto,
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: vi.fn(),
        }) as never,
        ResizeObserver: class {
          observe(): void {}
          disconnect(): void {}
        } as never,
        requestAnimationFrame(callback: FrameRequestCallback) {
          nextFrameId += 1;
          animationFrames.set(nextFrameId, callback);
          return nextFrameId;
        },
        cancelAnimationFrame(id: number) {
          animationFrames.delete(id);
        },
        setTimeout(callback: () => void) {
          nextTimeoutId += 1;
          timeouts.set(nextTimeoutId, callback);
          return nextTimeoutId;
        },
        clearTimeout(id: number) {
          timeouts.delete(id);
        },
      }),
    ).rejects.toThrow("Required DOM nodes are missing");
  });

  it("logs session selector fetch failures and attaches selected sessions", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "localhost", reload },
      configurable: true,
    });

    class FakeResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        this.callback();
      }
      disconnect(): void {}
    }

    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce("network string down")
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          sessions: [
            {
              sessionId: "tmux:session-b",
              tmuxSessionName: "session-b",
              cols: 90,
              rows: 25,
              connected: false,
              durable: true,
              idleExpiresAt: null,
              source: "tmux",
            },
          ],
        }),
      });

    const { mountTerminalApp } = await import("../src/app.js");
    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-a" } as Crypto,
      fetch: fetch as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: ((callback: () => void) => {
        nextTimeoutId += 1;
        timeouts.set(nextTimeoutId, callback);
        return nextTimeoutId;
      }) as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });

    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(
      "[browser-terminal] Failed to hydrate browser terminal sessions",
      { error: "network down" },
    );

    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-a" } as Crypto,
      fetch: fetch as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: ((callback: () => void) => {
        nextTimeoutId += 1;
        timeouts.set(nextTimeoutId, callback);
        return nextTimeoutId;
      }) as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(
      "[browser-terminal] Failed to hydrate browser terminal sessions",
      { error: "network string down" },
    );

    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-a" } as Crypto,
      fetch: fetch as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: ((callback: () => void) => {
        nextTimeoutId += 1;
        timeouts.set(nextTimeoutId, callback);
        return nextTimeoutId;
      }) as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalledWith(
      "[browser-terminal] Failed to fetch browser terminal sessions",
      { status: "503" },
    );

    await mountTerminalApp({
      document,
      location: window.location,
      localStorage: storage,
      crypto: { randomUUID: () => "session-a" } as Crypto,
      fetch: fetch as never,
      ResizeObserver: FakeResizeObserver as never,
      requestAnimationFrame: ((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        animationFrames.set(nextFrameId, callback);
        return nextFrameId;
      }) as never,
      cancelAnimationFrame: ((id: number) => {
        animationFrames.delete(id);
      }) as never,
      setTimeout: ((callback: () => void) => {
        nextTimeoutId += 1;
        timeouts.set(nextTimeoutId, callback);
        return nextTimeoutId;
      }) as never,
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as never,
    });
    await Promise.resolve();

    const selectEl = document.querySelector<HTMLSelectElement>("#session-select");
    selectEl!.value = "tmux:session-b";
    document.querySelector<HTMLButtonElement>("#attach-session")?.click();
    expect(storage.getItem("terminal-platform.session-id")).toBe("tmux:session-b");
    expect(reload).toHaveBeenCalled();
  });
});

function flushAllAnimationFrames(): void {
  while (animationFrames.size > 0) {
    const entries = Array.from(animationFrames.entries());
    animationFrames.clear();
    for (const [, callback] of entries) {
      callback(16);
    }
  }
}

function flushAllTimeouts(): void {
  while (timeouts.size > 0) {
    const entries = Array.from(timeouts.entries());
    timeouts.clear();
    for (const [, callback] of entries) {
      callback();
    }
  }
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
