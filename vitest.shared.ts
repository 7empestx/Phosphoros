import type { UserConfig } from "vitest/config";

export function strictCoverageConfig(
  include: string[],
  environment: "node" | "jsdom" = "node",
): UserConfig {
  return {
    test: {
      environment,
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
        include,
        exclude: ["test/**", "dist/**", "**/*.d.ts", "**/*.map", "src/styles.css"],
        thresholds: {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  };
}
