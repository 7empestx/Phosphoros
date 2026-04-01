import { describe, expect, it, vi } from "vitest";

import { log } from "../src/logger.js";

describe("logger", () => {
  it("writes info logs to stdout and error logs to stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    log("info", "hello", { short: "value" });
    log("error", "boom", { long: "x".repeat(450) });

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("[info] hello"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[error] boom"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("..."));

    stdout.mockRestore();
    stderr.mockRestore();
  });
});
