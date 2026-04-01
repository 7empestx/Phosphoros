import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({ port: 8787 })),
}));

vi.mock("../src/server.js", () => ({
  startTerminalServer: vi.fn(),
}));

describe("terminal-server entrypoint", () => {
  it("starts the server with loaded config", async () => {
    await import("../src/index.js");
    const { loadConfig } = await import("../src/config.js");
    const { startTerminalServer } = await import("../src/server.js");

    expect(loadConfig).toHaveBeenCalled();
    expect(startTerminalServer).toHaveBeenCalledWith({ port: 8787 });
  });
});
