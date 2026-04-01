import { loadConfig } from "./config.js";
import { startTerminalServer } from "./server.js";

startTerminalServer(loadConfig());
