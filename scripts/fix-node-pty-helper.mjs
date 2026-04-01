import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function isExecutable(mode) {
  return (mode & 0o111) !== 0;
}

function fixNodePtyHelpers() {
  const pnpmDir = path.resolve(process.cwd(), "node_modules/.pnpm");
  if (!existsSync(pnpmDir)) {
    return;
  }

  const packageDirs = readdirSync(pnpmDir).filter((entry) => entry.startsWith("node-pty@"));

  for (const packageDir of packageDirs) {
    const prebuildsDir = path.join(
      pnpmDir,
      packageDir,
      "node_modules",
      "node-pty",
      "prebuilds",
    );

    if (!existsSync(prebuildsDir)) {
      continue;
    }

    for (const platformDir of readdirSync(prebuildsDir)) {
      const helperPath = path.join(prebuildsDir, platformDir, "spawn-helper");
      if (!existsSync(helperPath)) {
        continue;
      }

      const mode = statSync(helperPath).mode;
      if (isExecutable(mode)) {
        continue;
      }

      chmodSync(helperPath, 0o755);
      process.stdout.write(`fixed executable bit on ${helperPath}\n`);
    }
  }
}

fixNodePtyHelpers();
