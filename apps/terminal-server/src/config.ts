import path from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_SHELL_PATHS = ["/bin/zsh", "/bin/bash"] as const;
const DEFAULT_TMUX_PATHS = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
] as const;

export interface ServerConfig {
  host: string;
  port: number;
  websocketPath: string;
  shellPath: string;
  shellArgs: string[];
  allowedShellPaths: string[];
  workingDirectory: string;
  allowedWorkingDirectories: string[];
  tmuxPath: string;
  replayBufferBytes: number;
  idleTtlMs: number;
  authToken: string;
}

const DEFAULT_WORKDIR = process.env.HOME ?? path.resolve(process.cwd());

export function loadConfig(env = process.env): ServerConfig {
  const shellPath = env.SHELL_PATH ?? "/bin/zsh";
  const shellArgs = splitList(env.SHELL_ARGS);
  const workingDirectory = path.resolve(env.WORKDIR ?? DEFAULT_WORKDIR);
  const tmuxPath = env.TMUX_PATH ?? resolveTmuxPath();
  const allowedShellPaths = splitList(env.ALLOWED_SHELL_PATHS).length
    ? splitList(env.ALLOWED_SHELL_PATHS)
    : [...DEFAULT_SHELL_PATHS];
  const allowedWorkingDirectories = splitList(env.ALLOWED_WORKDIRS).length
    ? splitList(env.ALLOWED_WORKDIRS).map((entry) => path.resolve(entry))
    : [workingDirectory];

  if (!allowedShellPaths.includes(shellPath)) {
    throw new Error(`Configured shell path is not allowlisted: ${shellPath}`);
  }

  if (!allowedWorkingDirectories.includes(workingDirectory)) {
    throw new Error(
      `Configured working directory is not allowlisted: ${workingDirectory}`,
    );
  }

  const port = Number(env.PORT ?? 8787);
  const replayBufferBytes = Number(env.REPLAY_BUFFER_BYTES ?? 2 * 1024 * 1024);
  const idleTtlMs = Number(env.IDLE_TTL_MS ?? 30 * 60 * 1000);

  assertPositiveInteger(port, "PORT");
  assertPositiveInteger(replayBufferBytes, "REPLAY_BUFFER_BYTES");
  assertPositiveInteger(idleTtlMs, "IDLE_TTL_MS");

  return {
    host: env.HOST ?? "0.0.0.0",
    port,
    websocketPath: env.WEBSOCKET_PATH ?? "/ws",
    shellPath,
    shellArgs,
    allowedShellPaths,
    workingDirectory,
    allowedWorkingDirectories,
    tmuxPath,
    replayBufferBytes,
    idleTtlMs,
    authToken: env.AUTH_TOKEN ?? "dev-token",
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function resolveTmuxPath(): string {
  for (const candidate of DEFAULT_TMUX_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "tmux";
}
