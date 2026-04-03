# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Phosphoros is a browser-based terminal platform where the backend maintains durable tmux sessions and the browser is an ephemeral projection. WebSocket disconnects don't kill the shell — PTY output is buffered server-side (2 MB RingBuffer) for replay on reconnect.

## Commands

```sh
pnpm install          # Install dependencies (postinstall fixes node-pty binary permissions)
pnpm build            # Build all packages
pnpm dev              # Run web + terminal-server concurrently
pnpm test             # Run all tests
pnpm test:coverage    # Tests with coverage (100% threshold enforced)
pnpm check            # TypeScript type checking across all packages

# Run tests for a single package
pnpm --filter @terminal-platform/protocol test
pnpm --filter @terminal-platform/client test
pnpm --filter @terminal-platform/terminal-server test
pnpm --filter @terminal-platform/web test

# Run a single test file
pnpm --filter @terminal-platform/terminal-server exec vitest run test/RingBuffer.test.ts
```

## Architecture

Four packages in a pnpm workspace monorepo:

- **packages/protocol** — Shared message types and binary frame encoding/decoding for client↔server communication. All message schemas (auth, input, resize, ping, detach, terminate; ready, output, snapshot, error, exit) live here.
- **packages/client** — `TerminalConnection` class: WebSocket management with auto-reconnect, handles both JSON messages and binary PTY output frames.
- **apps/web** — Vite SPA mounting `ghostty-web` terminal emulator. Manages session persistence (localStorage UUID), UI state (topbar, inspector sidebar, session selector), and write batching via `TerminalWriteBuffer`.
- **apps/terminal-server** — Node.js WebSocket server. Key components:
  - `SessionManager` — manages TerminalSession instances, handles auth, coordinates tmux
  - `TerminalSession` — owns PTY (node-pty), manages client attachment, records output to RingBuffer
  - `RingBuffer` — circular buffer for output replay on reconnect
  - `config.ts` — environment-based config with shell path and workdir allowlists
  - `http.ts` — `/healthz` and `/sessions` endpoints
  - `websocket.ts` — message routing and auth validation

**Connection flow:** Browser authenticates with token + session ID over WebSocket → server creates/reuses tmux session → attaches node-pty → binary PTY output streams to client → on reconnect, snapshot replayed from RingBuffer then live stream resumes.

## Tech Stack

- **Runtime:** Node 22+, pnpm 9.15.4 (via Corepack)
- **Language:** TypeScript (strict, ESM, ES2022 target)
- **Test framework:** Vitest (node environment for server/packages, jsdom for web)
- **Build:** tsc for server/packages, Vite for web
- **Deployment:** Docker Compose (workspace-init → terminal-server → web)

## Key Environment Variables

Terminal server: `PORT` (8787), `HOST`, `SHELL_PATH`, `WORKDIR`, `ALLOWED_SHELL_PATHS`, `ALLOWED_WORKDIRS`, `AUTH_TOKEN` ("dev-token"), `TMUX_PATH`, `REPLAY_BUFFER_BYTES`, `IDLE_TTL_MS`.

Web app (Vite): `VITE_TERMINAL_WS_URL` (ws://localhost:8787/ws), `VITE_TERMINAL_AUTH_TOKEN` ("dev-token").
