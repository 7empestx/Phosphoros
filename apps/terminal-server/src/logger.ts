export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): void {
  if (level === "debug" && process.env?.LOG_LEVEL !== "debug") {
    return;
  }

  const timestamp = new Date().toISOString();
  const payload =
    Object.keys(context).length === 0 ? "" : ` ${JSON.stringify(sanitizeContext(context))}`;
  const line = `[${timestamp}] [${level}] ${message}${payload}\n`;

  if (level === "error") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      if (typeof value === "string" && value.length > 400) {
        return [key, `${value.slice(0, 397)}...`];
      }

      return [key, value];
    }),
  );
}
