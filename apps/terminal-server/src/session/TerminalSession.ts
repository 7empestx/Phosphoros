import { execFile } from "node:child_process";

import { spawn, type IPty } from "node-pty";
import type WebSocket from "ws";
import { encodeBinaryFrame } from "@terminal-platform/protocol";

import type { ServerConfig } from "../config.js";
import { log } from "../logger.js";
import { RingBuffer } from "./RingBuffer.js";

export interface SessionSnapshot {
  sessionId: string;
  cols: number;
  rows: number;
  connected: boolean;
  durable: boolean;
  idleExpiresAt: string | null;
}

export interface AttachResult {
  snapshot: Buffer;
}

export interface TerminalSessionDependencies {
  execFileAsync: (file: string, args: string[]) => Promise<unknown>;
  spawnPty: typeof spawn;
  now: () => number;
  setTimeoutImpl: typeof setTimeout;
  clearTimeoutImpl: typeof clearTimeout;
}

export class TerminalSession {
  readonly sessionId: string;
  private readonly tmuxSessionName: string;
  private readonly config: ServerConfig;
  private readonly ringBuffer: RingBuffer;
  private transport: IPty | null = null;
  private socket: WebSocket | null = null;
  private cols = 120;
  private rows = 40;
  private idleExpiresAt: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closingTransport = false;
  private terminated = false;
  private pendingOutput: Buffer[] = [];
  private pendingOutputBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeBurstStartedAt = 0;
  private resizeBurstCount = 0;
  private readonly deps: TerminalSessionDependencies;

  constructor(
    sessionId: string,
    config: ServerConfig,
    deps: Partial<TerminalSessionDependencies> = {},
  ) {
    this.sessionId = sessionId;
    this.tmuxSessionName = toTmuxName(sessionId);
    this.config = config;
    this.ringBuffer = new RingBuffer(config.replayBufferBytes);
    this.deps = {
      execFileAsync(file, args) {
        return new Promise((resolve, reject) => {
          execFile(file, args, (error, stdout, stderr) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        });
      },
      spawnPty: spawn,
      now: () => Date.now(),
      setTimeoutImpl: setTimeout,
      clearTimeoutImpl: clearTimeout,
      ...deps,
    };
  }

  async attach(socket: WebSocket, cols: number, rows: number): Promise<AttachResult> {
    log("info", "Attaching websocket to terminal session", {
      sessionId: this.sessionId,
      cols,
      rows,
    });
    this.cancelIdleTimer();
    this.cols = cols;
    this.rows = rows;

    if (this.socket && this.socket !== socket) {
      log("warn", "Replacing existing websocket for terminal session", {
        sessionId: this.sessionId,
      });
      this.socket.close(1012, "Another client attached to this session");
    }

    if (this.transport) {
      log("info", "Closing previous transport before reattach", {
        sessionId: this.sessionId,
      });
      this.closeTransport();
    }

    this.socket = socket;
    await this.ensureTmuxSession();
    this.transport = this.spawnTransport(cols, rows);

    return {
      snapshot: this.ringBuffer.snapshot(),
    };
  }

  write(data: string): void {
    if (!this.transport) {
      log("warn", "Received terminal input without active PTY transport", {
        sessionId: this.sessionId,
        bytes: Buffer.byteLength(data),
        preview: previewTerminalInput(data),
      });
      return;
    }

    log(/[\r\n]$/.test(data) ? "info" : "debug", "Writing input to PTY", {
      sessionId: this.sessionId,
      bytes: Buffer.byteLength(data),
      preview: previewTerminalInput(data),
    });
    this.transport.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) {
      log("debug", "Ignoring redundant PTY resize", {
        sessionId: this.sessionId,
        cols,
        rows,
      });
      return;
    }

    const now = this.deps.now();
    if (this.resizeBurstStartedAt === 0 || now - this.resizeBurstStartedAt > 1_000) {
      this.resizeBurstStartedAt = now;
      this.resizeBurstCount = 0;
    }
    this.resizeBurstCount += 1;

    log(this.resizeBurstCount > 6 ? "warn" : "info", "Updating PTY size", {
      sessionId: this.sessionId,
      previousCols: this.cols,
      previousRows: this.rows,
      cols,
      rows,
      resizeBurstCount: this.resizeBurstCount,
    });
    this.cols = cols;
    this.rows = rows;
    this.transport?.resize(cols, rows);
  }

  detach(): void {
    log("info", "Detaching PTY transport", { sessionId: this.sessionId });
    this.socket = null;
    this.closeTransport();
    this.clearPendingOutput();
    this.scheduleIdleTimeout();
  }

  async terminate(): Promise<void> {
    log("warn", "Destroying terminal session", { sessionId: this.sessionId });
    this.terminated = true;
    this.socket = null;
    this.closeTransport();
    this.clearPendingOutput();
    this.ringBuffer.clear();
    this.cancelIdleTimer();
    await this.killTmuxSession();
  }

  getSnapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      cols: this.cols,
      rows: this.rows,
      connected: Boolean(this.socket),
      durable: true,
      idleExpiresAt:
        this.idleExpiresAt === null ? null : new Date(this.idleExpiresAt).toISOString(),
    };
  }

  getTmuxSessionName(): string {
    return this.tmuxSessionName;
  }

  isExpired(now = Date.now()): boolean {
    return this.idleExpiresAt !== null && now >= this.idleExpiresAt;
  }

  async disposeIfExpired(): Promise<boolean> {
    if (!this.isExpired()) {
      return false;
    }

    await this.terminate();
    return true;
  }

  private async ensureTmuxSession(): Promise<void> {
    try {
      await this.deps.execFileAsync(this.config.tmuxPath, ["has-session", "-t", this.tmuxSessionName]);
      log("info", "Found existing tmux session", {
        sessionId: this.sessionId,
        tmuxSessionName: this.tmuxSessionName,
      });
    } catch {
      log("info", "Creating new tmux session", {
        sessionId: this.sessionId,
        tmuxSessionName: this.tmuxSessionName,
      });
      await this.deps.execFileAsync(this.config.tmuxPath, [
        "new-session",
        "-d",
        "-s",
        this.tmuxSessionName,
        "-c",
        this.config.workingDirectory,
        this.config.shellPath,
        ...this.config.shellArgs,
      ]);
    }
  }

  private spawnTransport(cols: number, rows: number): IPty {
    log("info", "Spawning PTY transport", {
      sessionId: this.sessionId,
      tmuxPath: this.config.tmuxPath,
      cols,
      rows,
    });
    const transport = this.deps.spawnPty(
      this.config.tmuxPath,
      ["new-session", "-A", "-s", this.tmuxSessionName, "-c", this.config.workingDirectory],
      {
        name: "xterm-256color",
        cols,
        rows,
        cwd: this.config.workingDirectory,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "AUTH_TOKEN")),
      },
    );

    transport.onData((data) => {
      const buffer = Buffer.from(data);
      this.ringBuffer.append(buffer);
      log("debug", "Received PTY output chunk", {
        sessionId: this.sessionId,
        bytes: buffer.length,
        socketAttached: Boolean(this.socket),
      });
      this.enqueueOutput(buffer);
    });

    transport.onExit(async ({ exitCode, signal }) => {
      log("warn", "PTY transport exited", {
        sessionId: this.sessionId,
        exitCode,
        signal,
        closingTransport: this.closingTransport,
        terminated: this.terminated,
      });
      this.transport = null;

      if (this.closingTransport || this.terminated) {
        this.closingTransport = false;
        return;
      }

      const tmuxAlive = await this.tmuxSessionExists();
      if (tmuxAlive) {
        log("info", "PTY exited but tmux session is still alive", {
          sessionId: this.sessionId,
        });
        this.scheduleIdleTimeout();
        return;
      }

      log("warn", "PTY exited and tmux session is gone", {
        sessionId: this.sessionId,
      });
      this.socket?.send(
        JSON.stringify({
          type: "exit",
          sessionId: this.sessionId,
          exitCode,
          signal,
        }),
      );
      this.socket?.close();
      this.socket = null;
      this.scheduleIdleTimeout();
    });

    return transport;
  }
  private closeTransport(): void {
    if (!this.transport) {
      log("info", "No PTY transport to close", { sessionId: this.sessionId });
      return;
    }

    log("info", "Closing PTY transport", { sessionId: this.sessionId });
    this.closingTransport = true;
    this.transport.kill();
    this.transport = null;
  }

  private enqueueOutput(buffer: Buffer): void {
    if (!buffer.length) {
      return;
    }

    this.pendingOutput.push(buffer);
    this.pendingOutputBytes += buffer.length;
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = this.deps.setTimeoutImpl(() => {
      this.flushTimer = null;
      this.flushOutput();
    }, 0);
  }

  private flushOutput(): void {
    if (!this.socket || this.pendingOutputBytes === 0) {
      if (this.pendingOutputBytes > 0) {
        log("warn", "Dropping buffered PTY output without active websocket", {
          sessionId: this.sessionId,
          bytes: this.pendingOutputBytes,
          chunks: this.pendingOutput.length,
        });
      }
      this.clearPendingOutput();
      return;
    }

    const payload = Buffer.concat(this.pendingOutput, this.pendingOutputBytes);
    log("debug", "Streaming batched PTY output", {
      sessionId: this.sessionId,
      bytes: payload.length,
      chunks: this.pendingOutput.length,
    });
    this.socket.send(encodeBinaryFrame({ kind: "output", data: payload }), { binary: true });
    this.clearPendingOutput();
  }

  private async killTmuxSession(): Promise<void> {
    try {
      log("warn", "Killing tmux session", {
        sessionId: this.sessionId,
        tmuxSessionName: this.tmuxSessionName,
      });
      await this.deps.execFileAsync(this.config.tmuxPath, ["kill-session", "-t", this.tmuxSessionName]);
    } catch {
      log("warn", "Tmux session was already gone during kill", {
        sessionId: this.sessionId,
        tmuxSessionName: this.tmuxSessionName,
      });
      return;
    }
  }

  private async tmuxSessionExists(): Promise<boolean> {
    try {
      await this.deps.execFileAsync(this.config.tmuxPath, ["has-session", "-t", this.tmuxSessionName]);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleIdleTimeout(): void {
    this.cancelIdleTimer();
    this.idleExpiresAt = this.deps.now() + this.config.idleTtlMs;
    log("info", "Scheduled idle termination for terminal session", {
      sessionId: this.sessionId,
      idleExpiresAt: new Date(this.idleExpiresAt).toISOString(),
    });
    this.idleTimer = this.deps.setTimeoutImpl(() => {
      void this.terminate();
    }, this.config.idleTtlMs);
  }

  private cancelIdleTimer(): void {
    this.idleExpiresAt = null;
    if (this.idleTimer) {
      log("info", "Clearing idle termination timer", { sessionId: this.sessionId });
      this.deps.clearTimeoutImpl(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearPendingOutput(): void {
    if (this.flushTimer) {
      this.deps.clearTimeoutImpl(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
  }
}

function previewTerminalInput(data: string): string {
  return data.replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, 80);
}

function toTmuxName(sessionId: string): string {
  if (sessionId.startsWith("tmux:")) {
    return sessionId.slice("tmux:".length);
  }

  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `terminal-${sanitized}`.slice(0, 64);
}
