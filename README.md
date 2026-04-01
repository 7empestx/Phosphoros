# Browser Terminal Platform

A fresh TypeScript monorepo for a durable browser terminal platform built around `ghostty-web`, `node-pty`, `tmux`, and a shared websocket protocol.

## Repo Layout

- `apps/web`: Vite browser app that mounts `ghostty-web` and reconnects with a stable browser-side session id.
- `apps/terminal-server`: Node websocket server that owns PTY lifecycle, attaches clients to durable `tmux` sessions, and replays buffered output.
- `packages/protocol`: Shared client/server websocket message types and parsing helpers.
- `packages/client`: Reusable browser-side websocket adapter with reconnect handling.

## Architecture

- The browser is an ephemeral projection. It renders terminal output and sends input/resize events, but it does not own durable shell state.
- The backend is the source of truth. It authenticates a client, maps it to a session id, and manages session lifecycle through `SessionManager` and `TerminalSession`.
- Durability comes from `tmux`. Each logical session maps to a named `tmux` session. Websocket disconnects only tear down the transport PTY, not the shell state inside `tmux`.
- Replay comes from a server-side `RingBuffer`. Live PTY output is sent over websocket binary frames and mirrored into a roughly 2 MB in-memory replay buffer. On reconnect, the server sends a `snapshot` message before live streaming continues.
- Safety boundaries are server-side. The shell path and working directory are allowlisted in configuration, and the client cannot request arbitrary commands.
- The current model uses single-writer semantics. A new attachment replaces the previous live websocket for the same logical session.

## Protocol

Client messages:

- `auth`
- `input`
- `resize`
- `ping`
- `detach`
- `terminate`

Server messages:

- `ready`
- `output`
- `session_status`
- `snapshot`
- `pong`
- `exit`
- `error`

## Local Development

### Preferred: Docker Compose

This repo ships with a Compose setup that starts:

- `terminal-server` on `8787`
- `web` on `5173`

Run:

```sh
docker compose up --build
```

If your Docker install still uses the legacy standalone binary, use the equivalent command provided by your environment.

Open [http://localhost:5173](http://localhost:5173).

### Local Node Workflow

Requirements:

- Node 22
- `tmux`
- `pnpm` via Corepack

Bootstrap:

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install
```

Run both apps in separate terminals:

```sh
pnpm --filter @terminal-platform/terminal-server dev
pnpm --filter @terminal-platform/web dev
```

The browser app expects the terminal server at `ws://localhost:8787/ws` by default.

## Scripts

```sh
pnpm build
pnpm test
pnpm test:coverage
pnpm check
```

Coverage is enforced at 100% statements, branches, functions, and lines for the protocol, client, terminal server, and web app source packages.

## What Works

- Monorepo scaffold with `pnpm` workspaces and TypeScript packages/apps.
- Shared websocket protocol types and a reusable browser websocket adapter.
- Browser terminal page that initializes `ghostty-web`, connects to the backend, and persists a logical session id in `localStorage`.
- Node websocket server with `SessionManager`, `TerminalSession`, `RingBuffer`, `node-pty`, and `tmux`-backed durable sessions.
- Server-driven replay snapshot on reconnect.
- Dockerized dev environment for the web app and terminal server.
- Basic tests for protocol parsing, client reconnect behavior, config allowlists, and ring buffer trimming.

## What Is Still Stubbed Or Intentionally Minimal

- Auth is a development placeholder based on a shared token. The shape is ready for a future signed-token verifier, but the verifier itself is not implemented yet.
- Session replay is in-memory only. The durable shell state lives in `tmux`, but replay history is not yet persisted across server restarts.
- The browser app currently uses a fixed terminal size baseline instead of a true fit algorithm.
- There is no multiplexed collaboration model yet beyond single-writer handoff.
- The `output` server message type exists in the protocol, but the server currently prefers websocket binary frames for live PTY output.

## Recommended Next Steps

- Replace the development token check with signed auth tokens minted by the embedding product.
- Add a fit strategy so the browser computes terminal dimensions from layout and font metrics.
- Persist session metadata and replay buffers if reconnect across server restarts matters.
- Add structured audit logging and explicit session ownership checks.
- Harden the build and release flow for publishing the shared packages externally.
