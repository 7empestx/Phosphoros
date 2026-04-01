import { TerminalConnection } from "@terminal-platform/client";
import type { BinaryFrame, ServerMessage } from "@terminal-platform/protocol";
import { FitAddon, Terminal, init } from "ghostty-web";
import ghosttyWasmUrl from "ghostty-web/ghostty-vt.wasm?url";

export const SESSION_STORAGE_KEY = "terminal-platform.session-id";
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 34;
const FIT_WIDTH_MARGIN_PX = 12;

interface TerminalDimensions {
  cols: number;
  rows: number;
}

function calcFit(el: HTMLElement): { cols: number; rows: number } {
  if (!el.clientWidth || !el.clientHeight) {
    return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  }
  const probe = el.ownerDocument.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;font-family:monospace;font-size:14px;line-height:normal";
  probe.textContent = "X";
  el.ownerDocument.body.appendChild(probe);
  const charW = probe.offsetWidth || 8;
  const charH = probe.offsetHeight || 17;
  el.ownerDocument.body.removeChild(probe);
  const usableWidth = Math.max(charW * 2, el.clientWidth - FIT_WIDTH_MARGIN_PX);
  return {
    cols: Math.max(2, Math.floor(usableWidth / charW) - 1),
    rows: Math.max(1, Math.floor(el.clientHeight / charH)),
  };
}

export interface BrowserRuntime {
  document: Document;
  location: Location;
  localStorage: Storage;
  crypto: Crypto;
  fetch: typeof fetch;
  ResizeObserver: typeof ResizeObserver;
  requestAnimationFrame: typeof requestAnimationFrame;
  cancelAnimationFrame: typeof cancelAnimationFrame;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

interface StatusView {
  text: HTMLElement;
  dot: HTMLElement;
}

interface SessionListResponse {
  sessions: Array<{
    sessionId: string;
    tmuxSessionName: string;
    cols: number | null;
    rows: number | null;
    connected: boolean;
    durable: boolean;
    idleExpiresAt: string | null;
    source: "memory" | "tmux";
  }>;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const MAX_FLUSH_BYTES = 128 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;

export async function mountTerminalApp(runtime: BrowserRuntime = window): Promise<void> {
  const app = runtime.document.querySelector<HTMLDivElement>("#app");

  if (!app) {
    throw new Error("App root not found");
  }

  app.innerHTML = `
    <div class="crt-overlay"></div>
    <header class="topbar">
      <div class="topbar-brand">PHOSPHOR_OS_v1.0.4</div>
      <div class="topbar-status">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Connecting...</span>
      </div>
    </header>
    <main class="shell-layout">
      <section class="terminal-shell">
        <div class="terminal-viewport">
          <div class="terminal-frame">
            <div class="terminal-surface">
              <div id="terminal"></div>
              <div class="terminal-watermark">PHOSPHOR</div>
            </div>
            <div class="terminal-footer">
              <div class="footer-status">
                <span class="status-dot" data-state="connected"></span>
                <span>Connected</span>
              </div>
              <div class="footer-meta">tmux durable session</div>
            </div>
          </div>
        </div>
      </section>
      <aside class="inspector">
        <div class="inspector-head">
          <h1>INSPECTOR_V1</h1>
          <p class="eyebrow">OPERATOR_01</p>
        </div>
        <section class="panel-block">
          <div class="panel-label">Session Identity</div>
          <div class="panel-grid">
            <div class="panel-row">
              <span class="panel-key">Session ID</span>
              <code class="session-code" id="session-id"></code>
            </div>
            <div class="panel-row">
              <span class="panel-key">Shell</span>
              <span class="panel-value" id="shell-name">ZSH</span>
            </div>
            <div class="panel-row">
              <span class="panel-key">Durability</span>
              <span class="panel-value" id="durability-mode">TMUX-BACKED</span>
            </div>
          </div>
        </section>
        <section class="panel-block panel-block-muted">
          <div class="panel-label">Connection State</div>
          <div class="panel-grid">
            <div class="panel-row">
              <span class="panel-key">Status</span>
              <span class="panel-value panel-status">
                <span class="status-dot" id="inspector-status-dot"></span>
                <span id="inspector-status-text">Connecting...</span>
              </span>
            </div>
            <div class="panel-row">
              <span class="panel-key">Geometry</span>
              <span class="panel-value" id="terminal-geometry">120 x 34</span>
            </div>
            <div class="panel-row">
              <span class="panel-key">Transport</span>
              <span class="panel-value">WS_BINARY</span>
            </div>
            <div class="panel-row">
              <span class="panel-key">Truth</span>
              <span class="panel-value">SERVER_LIFECYCLE</span>
            </div>
          </div>
        </section>
        <section class="panel-block">
          <div class="panel-label">Controls</div>
          <div class="panel-grid">
            <div class="panel-row panel-row-stack">
              <span class="panel-key">Running Sessions</span>
              <select id="session-select" class="session-select">
                <option value="">Current session</option>
              </select>
            </div>
            <div class="action-row action-row-split">
              <button id="attach-session" type="button">Attach Session</button>
              <button id="reset-session" type="button">&gt; New Session</button>
            </div>
          </div>
          <p class="panel-note">
            Browser state is disposable. Start clean when an interactive program takes over.
          </p>
        </section>
      </aside>
    </main>
  `;

  const terminalMount = requiredNode(
    runtime.document.querySelector<HTMLDivElement>("#terminal"),
    "Required DOM nodes are missing",
  );
  const statusText = requiredNode(
    runtime.document.querySelector<HTMLSpanElement>("#status-text"),
    "Required DOM nodes are missing",
  );
  const statusDot = requiredNode(
    runtime.document.querySelector<HTMLSpanElement>("#status-dot"),
    "Required DOM nodes are missing",
  );
  const sessionIdElement = requiredNode(
    runtime.document.querySelector<HTMLElement>("#session-id"),
    "Required DOM nodes are missing",
  );
  const inspectorStatusText = requiredNode(
    runtime.document.querySelector<HTMLSpanElement>("#inspector-status-text"),
    "Required DOM nodes are missing",
  );
  const inspectorStatusDot = requiredNode(
    runtime.document.querySelector<HTMLSpanElement>("#inspector-status-dot"),
    "Required DOM nodes are missing",
  );
  const geometryElement = requiredNode(
    runtime.document.querySelector<HTMLElement>("#terminal-geometry"),
    "Required DOM nodes are missing",
  );
  const resetButton = requiredNode(
    runtime.document.querySelector<HTMLButtonElement>("#reset-session"),
    "Required DOM nodes are missing",
  );
  const attachButton = requiredNode(
    runtime.document.querySelector<HTMLButtonElement>("#attach-session"),
    "Required DOM nodes are missing",
  );
  const sessionSelect = requiredNode(
    runtime.document.querySelector<HTMLSelectElement>("#session-select"),
    "Required DOM nodes are missing",
  );

  await (init as unknown as (wasmUrl?: string) => Promise<void>)(ghosttyWasmUrl);

  const terminal = new Terminal({
    fontSize: 14,
    cursorBlink: true,
    theme: {
      background: "#08131f",
      foreground: "#d6e2f0",
    },
  });

  terminal.open(terminalMount);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const bufferedWriter = new TerminalWriteBuffer(terminal, runtime);
  const initDimensions = getTerminalDimensions(fitAddon, terminalMount);
  const { cols: initCols, rows: initRows } = initDimensions;
  terminal.resize(initCols, initRows);
  setGeometry(geometryElement, initCols, initRows);

  const existingSessionId = runtime.localStorage.getItem(SESSION_STORAGE_KEY);
  const sessionId = getOrCreateSessionId(runtime.localStorage, runtime.crypto);
  sessionIdElement.textContent = sessionId;
  logBrowserEvent(
    existingSessionId ? "info" : "info",
    existingSessionId ? "Reusing stored browser terminal session" : "Created browser terminal session",
    { sessionId },
  );

  const env = import.meta.env;
  const websocketUrl =
    env.VITE_TERMINAL_WS_URL ?? toWebSocketUrl(runtime.location, 8787, "/ws");
  const sessionsUrl = toHttpUrl(runtime.location, 8787, "/sessions");
  const authToken = env.VITE_TERMINAL_AUTH_TOKEN ?? "dev-token";

  const connection = new TerminalConnection({
    url: websocketUrl,
    reconnectDelayMs: 1_000,
    auth: {
      token: authToken,
      sessionId,
      cols: initCols,
      rows: initRows,
    },
  });

  terminal.onData((data) => {
    connection.sendInput(data);
  });

  resetButton.addEventListener("click", () => {
    logBrowserEvent("info", "Resetting browser terminal session", { sessionId });
    runtime.localStorage.removeItem(SESSION_STORAGE_KEY);
    runtime.location.reload();
  });
  attachButton.addEventListener("click", () => {
    if (!sessionSelect.value || sessionSelect.value === sessionId) {
      return;
    }
    logBrowserEvent("info", "Attaching browser terminal to selected session", {
      fromSessionId: sessionId,
      toSessionId: sessionSelect.value,
    });
    runtime.localStorage.setItem(SESSION_STORAGE_KEY, sessionSelect.value);
    runtime.location.reload();
  });

  void hydrateSessionSelector(
    runtime,
    sessionsUrl,
    sessionSelect,
    sessionId,
  );

  connection.connect({
    onOpen() {
      logBrowserEvent("info", "Connected browser terminal session", { sessionId });
      setStatusViews(
        [
          { text: statusText, dot: statusDot },
          { text: inspectorStatusText, dot: inspectorStatusDot },
        ],
        "connected",
        ["Connected", "CONNECTED"],
      );
    },
    onClose() {
      logBrowserEvent("warn", "Browser terminal connection closed", { sessionId });
      setStatusViews(
        [
          { text: statusText, dot: statusDot },
          { text: inspectorStatusText, dot: inspectorStatusDot },
        ],
        "connecting",
        ["Reconnecting...", "RECONNECTING"],
      );
    },
    onError() {
      logBrowserEvent("error", "Browser terminal connection error", { sessionId });
      setStatusViews(
        [
          { text: statusText, dot: statusDot },
          { text: inspectorStatusText, dot: inspectorStatusDot },
        ],
        "error",
        ["Connection error", "ERROR"],
      );
    },
    onBinaryFrame(frame) {
      handleBinaryFrame(bufferedWriter, frame);
    },
    onMessage(message) {
      handleMessage(bufferedWriter, message, [
        { text: statusText, dot: statusDot },
        { text: inspectorStatusText, dot: inspectorStatusDot },
      ]);
    },
  });

  const resizeObserver = new runtime.ResizeObserver(() => {
    resizeObserver.disconnect();
    runtime.setTimeout(() => {
      const { cols, rows } = getTerminalDimensions(fitAddon, terminalMount);
      if (cols === initCols && rows === initRows) {
        return;
      }

      terminal.resize(cols, rows);
      setGeometry(geometryElement, cols, rows);
      connection.resize(cols, rows);
    }, 50);
  });

  resizeObserver.observe(terminalMount);
}

export function handleMessage(
  writer: TerminalWriter,
  message: ServerMessage,
  statusViews: StatusView[],
): void {
  switch (message.type) {
    case "ready":
      setStatusViews(statusViews, "connected", [
        `Ready for ${message.sessionId}`,
        `READY ${message.sessionId.slice(0, 8)}`,
      ]);
      return;
    case "snapshot":
      writer.write(message.data);
      return;
    case "session_status":
      setStatusViews(
        statusViews,
        message.connected ? "connected" : "connecting",
        [
          message.connected ? "Attached" : "Detached",
          message.connected ? "ATTACHED" : "DETACHED",
        ],
      );
      return;
    case "error":
      setStatusViews(statusViews, "error", [
        `${message.code}: ${message.message}`,
        `${message.code}: ${message.message}`,
      ]);
      return;
    case "exit":
      setStatusViews(statusViews, "idle", ["Session exited", "SESSION EXITED"]);
      return;
    case "pong":
      return;
    case "output":
      writer.write(message.data);
      return;
  }
}

export function handleBinaryFrame(writer: TerminalWriter, frame: BinaryFrame): void {
  writer.write(textDecoder.decode(frame.data));
}

export function setStatus(
  statusText: HTMLElement,
  statusDot: HTMLElement,
  kind: "connected" | "connecting" | "error" | "idle",
  label: string,
): void {
  statusText.textContent = label;
  statusDot.dataset.state = kind;
}

export function setGeometry(target: HTMLElement, cols: number, rows: number): void {
  target.textContent = `${cols} x ${rows}`;
}

export function setStatusViews(
  views: StatusView[],
  kind: "connected" | "connecting" | "error" | "idle",
  labels: string[],
): void {
  views.forEach((view, index) => {
    setStatus(view.text, view.dot, kind, labels[index] ?? labels[0] ?? "");
  });
}

export function getOrCreateSessionId(storage: Storage, cryptoImpl: Crypto): string {
  const existing = storage.getItem(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const created = cryptoImpl.randomUUID();
  storage.setItem(SESSION_STORAGE_KEY, created);
  return created;
}

export function createFreshSessionId(storage: Storage, cryptoImpl: Crypto): string {
  const created = cryptoImpl.randomUUID();
  storage.setItem(SESSION_STORAGE_KEY, created);
  return created;
}

export function toWebSocketUrl(location: Location, port: number, pathname: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.hostname}:${port}${pathname}`;
}

export function toHttpUrl(location: Location, port: number, pathname: string): string {
  return `${location.protocol}//${location.hostname}:${port}${pathname}`;
}

export interface TerminalWriter {
  write(data: string): void;
}

export class TerminalWriteBuffer implements TerminalWriter {
  private readonly terminal: Terminal;
  private readonly requestAnimationFrameImpl: typeof requestAnimationFrame;
  private readonly cancelAnimationFrameImpl: typeof cancelAnimationFrame;
  private queue = "";
  private queuedBytes = 0;
  private scheduledFrame: number | null = null;
  private droppedBytes = 0;
  private paused = false;

  constructor(
    terminal: Terminal,
    runtime: Pick<BrowserRuntime, "requestAnimationFrame" | "cancelAnimationFrame">,
  ) {
    this.terminal = terminal;
    this.requestAnimationFrameImpl = runtime.requestAnimationFrame.bind(runtime);
    this.cancelAnimationFrameImpl = runtime.cancelAnimationFrame.bind(runtime);
  }

  write(data: string): void {
    if (!data) {
      return;
    }

    const bytes = textEncoder.encode(data).length;
    if (this.queuedBytes + bytes > MAX_BUFFERED_BYTES) {
      this.dropPendingOutput(bytes);
      return;
    }

    this.queue += data;
    this.queuedBytes += bytes;
    if (this.scheduledFrame !== null) {
      return;
    }

    this.scheduledFrame = this.requestAnimationFrameImpl(() => {
      this.scheduledFrame = null;
      this.flush();
    });
  }

  flush(): void {
    if (!this.queue) {
      return;
    }

    const chunk = this.queue.slice(0, MAX_FLUSH_BYTES);
    this.queue = this.queue.slice(chunk.length);
    this.queuedBytes = Math.max(0, this.queuedBytes - textEncoder.encode(chunk).length);
    this.terminal.write(chunk);

    if (this.queue) {
      this.scheduledFrame = this.requestAnimationFrameImpl(() => {
        this.scheduledFrame = null;
        this.flush();
      });
    }
  }

  clear(): void {
    if (this.scheduledFrame !== null) {
      this.cancelAnimationFrameImpl(this.scheduledFrame);
      this.scheduledFrame = null;
    }
    this.queue = "";
    this.queuedBytes = 0;
    this.droppedBytes = 0;
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get droppedOutputBytes(): number {
    return this.droppedBytes;
  }

  private dropPendingOutput(incomingBytes: number): void {
    this.clear();
    this.droppedBytes += incomingBytes;
    this.paused = true;
    this.terminal.write(
      "\r\n[terminal] Output paused to keep the browser responsive. Refresh to resume.\r\n",
    );
  }
}

function requiredNode<T>(value: T | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function getTerminalDimensions(
  fitAddon: Pick<FitAddon, "proposeDimensions">,
  terminalMount: HTMLElement,
): TerminalDimensions {
  return fitAddon.proposeDimensions() ?? calcFit(terminalMount);
}

async function hydrateSessionSelector(
  runtime: Pick<BrowserRuntime, "fetch">,
  sessionsUrl: string,
  select: HTMLSelectElement,
  currentSessionId: string,
): Promise<void> {
  try {
    const response = await runtime.fetch(sessionsUrl);
    if (!response.ok) {
      logBrowserEvent("warn", "Failed to fetch browser terminal sessions", {
        status: String(response.status),
      });
      return;
    }

    const payload = (await response.json()) as SessionListResponse;
    syncSessionSelectOptions(select, payload.sessions, currentSessionId);
  } catch (error) {
    logBrowserEvent("error", "Failed to hydrate browser terminal sessions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function syncSessionSelectOptions(
  select: HTMLSelectElement,
  sessions: SessionListResponse["sessions"],
  currentSessionId: string,
): void {
  select.innerHTML = "";
  const currentOption = select.ownerDocument.createElement("option");
  currentOption.value = currentSessionId;
  currentOption.textContent = `Current: ${currentSessionId.slice(0, 8)}`;
  select.appendChild(currentOption);

  for (const session of sessions) {
    if (session.sessionId === currentSessionId) {
      continue;
    }
    const option = select.ownerDocument.createElement("option");
    option.value = session.sessionId;
    option.textContent = formatSessionOptionLabel(session);
    select.appendChild(option);
  }

  select.value = currentSessionId;
}

function formatSessionOptionLabel(session: SessionListResponse["sessions"][number]): string {
  const geometry =
    session.cols !== null && session.rows !== null ? ` · ${session.cols}x${session.rows}` : "";
  const attached = session.connected ? " · attached" : "";
  const source = session.source === "tmux" ? " · tmux" : "";
  return `${session.tmuxSessionName}${geometry}${attached}${source}`;
}

function logBrowserEvent(
  level: "info" | "warn" | "error",
  message: string,
  context: Record<string, string>,
): void {
  console[level](`[browser-terminal] ${message}`, context);
}
