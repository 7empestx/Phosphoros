import { execFile } from "node:child_process";
import type WebSocket from "ws";

import type {
  AuthMessage,
  ErrorMessage,
  SessionStatusMessage,
} from "@terminal-platform/protocol";
import { PROTOCOL_VERSION, encodeBinaryFrame } from "@terminal-platform/protocol";

import type { ServerConfig } from "../config.js";
import { log } from "../logger.js";
import { TerminalSession } from "./TerminalSession.js";

const MAX_REPLAY_BYTES = 256 * 1024;

export interface AvailableSessionRecord {
  sessionId: string;
  tmuxSessionName: string;
  connected: boolean;
  durable: boolean;
  cols: number | null;
  rows: number | null;
  idleExpiresAt: string | null;
  source: "memory" | "tmux";
}

interface SessionManagerDependencies {
  execFileAsync: (file: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;
}

export class SessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly config: ServerConfig;
  private readonly deps: SessionManagerDependencies;

  constructor(config: ServerConfig, deps: Partial<SessionManagerDependencies> = {}) {
    this.config = config;
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
      ...deps,
    };
  }

  async handleAuth(socket: WebSocket, message: AuthMessage): Promise<void> {
    if (message.token !== this.config.authToken) {
      log("warn", "Rejected websocket auth", {
        sessionId: message.sessionId,
      });
      socket.send(
        JSON.stringify({
          type: "error",
          code: "AUTH_INVALID",
          message: "Authentication failed",
        } satisfies ErrorMessage),
      );
      socket.close(4001, "Authentication failed");
      return;
    }

    log("info", "Accepted websocket auth", {
      sessionId: message.sessionId,
      cols: message.cols,
      rows: message.rows,
    });
    const session = this.getOrCreateSession(message.sessionId);
    const { snapshot } = await session.attach(socket, message.cols, message.rows);

    socket.send(
      JSON.stringify({
        type: "ready",
        sessionId: session.sessionId,
        protocolVersion: PROTOCOL_VERSION,
        reconnectable: true,
      }),
    );

    socket.send(
      JSON.stringify({
        type: "session_status",
        ...session.getSnapshot(),
      } satisfies SessionStatusMessage),
    );

    if (snapshot.length > 0) {
      const replay =
        snapshot.length > MAX_REPLAY_BYTES
          ? snapshot.subarray(snapshot.length - MAX_REPLAY_BYTES)
          : snapshot;
      if (replay.length !== snapshot.length) {
        log("warn", "Trimmed replay snapshot before sending to client", {
          sessionId: message.sessionId,
          originalBytes: snapshot.length,
          replayBytes: replay.length,
        });
      }
      socket.send(encodeBinaryFrame({ kind: "snapshot", data: replay }), {
        binary: true,
      });
    }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log("warn", "Dropping terminal input for missing session", { sessionId });
      return;
    }

    log("debug", "Forwarding terminal input", {
      sessionId,
      bytes: Buffer.byteLength(data),
    });
    session.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log("warn", "Dropping resize for missing session", { sessionId, cols, rows });
      return;
    }

    log("debug", "Resizing terminal session", { sessionId, cols, rows });
    session.resize(cols, rows);
  }

  detach(sessionId: string): void {
    log("info", "Detaching terminal session", { sessionId });
    this.sessions.get(sessionId)?.detach();
  }

  async terminate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log("warn", "Tried to terminate missing terminal session", { sessionId });
      return;
    }

    log("warn", "Terminating terminal session", { sessionId });
    await session.terminate();
    this.sessions.delete(sessionId);
  }

  async reapExpiredSessions(): Promise<void> {
    const entries = Array.from(this.sessions.entries());
    for (const [sessionId, session] of entries) {
      const disposed = await session.disposeIfExpired();
      if (disposed) {
        log("info", "Disposed expired terminal session", { sessionId });
        this.sessions.delete(sessionId);
      }
    }
  }

  async listAvailableSessions(): Promise<AvailableSessionRecord[]> {
    const records = new Map<string, AvailableSessionRecord>();

    for (const session of this.sessions.values()) {
      const snapshot = session.getSnapshot();
      records.set(snapshot.sessionId, {
        sessionId: snapshot.sessionId,
        tmuxSessionName: session.getTmuxSessionName(),
        connected: snapshot.connected,
        durable: snapshot.durable,
        cols: snapshot.cols,
        rows: snapshot.rows,
        idleExpiresAt: snapshot.idleExpiresAt,
        source: "memory",
      });
    }

    for (const tmuxSessionName of await this.listTmuxSessionNames()) {
      const sessionId = toSessionId(tmuxSessionName);
      if (records.has(sessionId)) {
        continue;
      }

      records.set(sessionId, {
        sessionId,
        tmuxSessionName,
        connected: false,
        durable: true,
        cols: null,
        rows: null,
        idleExpiresAt: null,
        source: "tmux",
      });
    }

    return Array.from(records.values()).sort((left, right) =>
      left.tmuxSessionName.localeCompare(right.tmuxSessionName),
    );
  }

  private async listTmuxSessionNames(): Promise<string[]> {
    try {
      const { stdout = "" } = await this.deps.execFileAsync(this.config.tmuxPath, [
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      return stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch (error) {
      log("warn", "Failed to enumerate tmux sessions", {
        tmuxPath: this.config.tmuxPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  listSessions(): SessionStatusMessage[] {
    return Array.from(this.sessions.values()).map((session) => ({
      type: "session_status",
      ...session.getSnapshot(),
    }));
  }

  private getOrCreateSession(sessionId: string): TerminalSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      log("info", "Creating terminal session", { sessionId });
      session = new TerminalSession(sessionId, this.config);
      this.sessions.set(sessionId, session);
    } else {
      log("info", "Reusing terminal session", { sessionId });
    }

    return session;
  }
}

function toSessionId(tmuxSessionName: string): string {
  if (tmuxSessionName.startsWith("terminal-")) {
    return tmuxSessionName.slice("terminal-".length);
  }

  return `tmux:${tmuxSessionName}`;
}
