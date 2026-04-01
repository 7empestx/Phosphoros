import { defineConfig } from "vitest/config";

import { strictCoverageConfig } from "../../vitest.shared.js";

export default defineConfig(strictCoverageConfig(["src/**/*.ts"], "jsdom"));
