import type http from "node:http";

import type { ServerConfig } from "./config.js";
import type { AvailableSessionRecord, SessionManager } from "./session/SessionManager.js";
import { log } from "./logger.js";

export function createHttpRequestHandler(
  _config: ServerConfig,
  sessionManager: Pick<SessionManager, "listAvailableSessions">,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    void handleRequest(req, res, sessionManager);
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionManager: Pick<SessionManager, "listAvailableSessions">,
): Promise<void> {
  if (req.url === "/healthz") {
    log("info", "Health check request");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/sessions") {
    log("info", "Session list request");
    const sessions = await sessionManager.listAvailableSessions().catch((error) => {
      log("warn", "Failed to build session list", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [] as AvailableSessionRecord[];
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  log("warn", "Unhandled HTTP request", {
    url: req.url ?? null,
    method: "method" in req ? req.method : undefined,
  });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}
