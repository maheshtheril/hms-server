// server/src/lib/logger.ts
type LogLevel = "debug" | "info" | "warn" | "error";

function formatMeta(meta?: Record<string, any>) {
  if (!meta) return "";
  try {
    return " " + JSON.stringify(meta);
  } catch {
    return "";
  }
}

const logger = {
  debug(msg: string, meta?: Record<string, any>) {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[DEBUG] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
    }
  },
  info(msg: string, meta?: Record<string, any>) {
    console.info(`[INFO] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
  },
  warn(msg: string, meta?: Record<string, any>) {
    console.warn(`[WARN] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
  },
  error(msg: string, meta?: Record<string, any>) {
    console.error(`[ERROR] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
  },
  child(context: Record<string, any>) {
    // very small "child" emulation: returns a logger that prefixes messages with context
    const prefix = JSON.stringify(context);
    return {
      debug: (m: string, meta?: Record<string, any>) => logger.debug(`${prefix} ${m}`, meta),
      info: (m: string, meta?: Record<string, any>) => logger.info(`${prefix} ${m}`, meta),
      warn: (m: string, meta?: Record<string, any>) => logger.warn(`${prefix} ${m}`, meta),
      error: (m: string, meta?: Record<string, any>) => logger.error(`${prefix} ${m}`, meta)
    };
  }
};

export default logger;
export type { LogLevel };
