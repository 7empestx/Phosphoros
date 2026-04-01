import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("rejects non-allowlisted shells", () => {
    expect(() =>
      loadConfig({
        SHELL_PATH: "/bin/fish",
        ALLOWED_SHELL_PATHS: "/bin/zsh,/bin/bash",
      }),
    ).toThrow("Configured shell path is not allowlisted");
  });

  it("accepts configured allowlisted paths", () => {
    const config = loadConfig({
      SHELL_PATH: "/bin/zsh",
      SHELL_ARGS: "-f,-i",
      ALLOWED_SHELL_PATHS: "/bin/zsh,/bin/bash",
      WORKDIR: "/tmp",
      ALLOWED_WORKDIRS: "/tmp,/var/tmp",
    });

    expect(config.shellPath).toBe("/bin/zsh");
    expect(config.shellArgs).toEqual(["-f", "-i"]);
    expect(config.workingDirectory).toBe("/tmp");
    expect(config.tmuxPath).toBeTruthy();
  });

  it("uses defaults and rejects non-allowlisted working directories", () => {
    const config = loadConfig({
      WORKDIR: "/tmp",
    });

    expect(config.allowedShellPaths).toEqual(["/bin/zsh", "/bin/bash"]);
    expect(config.allowedWorkingDirectories).toEqual(["/tmp"]);

    expect(() =>
      loadConfig({
        WORKDIR: "/tmp/nope",
        ALLOWED_WORKDIRS: "/tmp,/var/tmp",
      }),
    ).toThrow("Configured working directory is not allowlisted");
  });

  it("rejects invalid numeric configuration", () => {
    expect(() =>
      loadConfig({
        PORT: "0",
      }),
    ).toThrow("PORT must be a positive integer");

    expect(() =>
      loadConfig({
        REPLAY_BUFFER_BYTES: "-1",
      }),
    ).toThrow("REPLAY_BUFFER_BYTES must be a positive integer");

    expect(() =>
      loadConfig({
        IDLE_TTL_MS: "abc",
      }),
    ).toThrow("IDLE_TTL_MS must be a positive integer");
  });

  it("falls back to bare tmux when common absolute paths are unavailable", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
    }));

    const { loadConfig: loadFreshConfig } = await import("../src/config.js");
    const config = loadFreshConfig();
    expect(config.tmuxPath).toBe("tmux");
    vi.doUnmock("node:fs");
  });
});
