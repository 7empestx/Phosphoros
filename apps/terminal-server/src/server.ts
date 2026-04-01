import http from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import type { ServerConfig } from "./config.js";
import { createHttpRequestHandler } from "./http.js";
import { log } from "./logger.js";
import { SessionManager } from "./session/SessionManager.js";
import {
  createConnectionHandler,
  createUpgradeHandler,
  handleMessage,
  type TerminalServerState,
} from "./websocket.js";

export interface TerminalServerDependencies {
  createHttpServer?: typeof http.createServer;
  WebSocketServerImpl?: typeof WebSocketServer;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  processRef?: Pick<NodeJS.Process, "stdout" | "exit" | "on">;
}

export function createTerminalServer(
  config: ServerConfig,
  deps: TerminalServerDependencies = {},
): {
  server: http.Server;
  websocketServer: WebSocketServer;
  sessionManager: SessionManager;
  shutdown: () => void;
} {
  const createHttpServer = deps.createHttpServer ?? http.createServer;
  const WebSocketServerImpl = deps.WebSocketServerImpl ?? WebSocketServer;
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const processRef = deps.processRef ?? process;

  const sessionManager = new SessionManager(config);
  const server = createHttpServer(createHttpRequestHandler(config, sessionManager));
  const websocketServer = new WebSocketServerImpl({ noServer: true });

  server.on("upgrade", createUpgradeHandler(config, websocketServer));
  websocketServer.on("connection", createConnectionHandler(sessionManager));

  const reapInterval = setIntervalImpl(() => {
    log("info", "Reaping expired sessions");
    void sessionManager.reapExpiredSessions();
  }, 60_000);

  const pingInterval = setIntervalImpl(() => {
    websocketServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    });
  }, 30_000);

  const shutdown = (): void => {
    log("warn", "Shutting down terminal server");
    clearIntervalImpl(reapInterval);
    clearIntervalImpl(pingInterval);
    websocketServer.clients.forEach((client) => client.close(1001, "Server shutdown"));
    server.close(() => {
      processRef.exit(0);
    });
  };

  processRef.on("SIGINT", shutdown);
  processRef.on("SIGTERM", shutdown);

  return { server, websocketServer, sessionManager, shutdown };
}

export function startTerminalServer(
  config: ServerConfig,
  deps: TerminalServerDependencies = {},
): ReturnType<typeof createTerminalServer> {
  const processRef = deps.processRef ?? process;
  log("info", "Starting terminal server", {
    host: config.host,
    port: config.port,
    websocketPath: config.websocketPath,
    shellPath: config.shellPath,
    workingDirectory: config.workingDirectory,
  });
  const instance = createTerminalServer(config, deps);
  instance.server.listen(config.port, config.host, () => {
    processRef.stdout.write(
      `terminal-server listening on http://${config.host}:${config.port}${config.websocketPath}\n`,
    );
  });
  return instance;
}

export { handleMessage };
export type { TerminalServerState };
