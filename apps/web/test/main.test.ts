import { describe, expect, it, vi } from "vitest";

vi.mock("../src/app.js", () => ({
  mountTerminalApp: vi.fn(() => Promise.resolve()),
}));

describe("web entrypoint", () => {
  it("mounts the terminal app", async () => {
    await import("../src/main.js");
    const { mountTerminalApp } = await import("../src/app.js");
    expect(mountTerminalApp).toHaveBeenCalled();
  });
});
