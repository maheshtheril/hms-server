"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function formatMeta(meta) {
    if (!meta)
        return "";
    try {
        return " " + JSON.stringify(meta);
    }
    catch {
        return "";
    }
}
const logger = {
    debug(msg, meta) {
        if (process.env.NODE_ENV !== "production") {
            console.debug(`[DEBUG] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
        }
    },
    info(msg, meta) {
        console.info(`[INFO] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
    },
    warn(msg, meta) {
        console.warn(`[WARN] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
    },
    error(msg, meta) {
        console.error(`[ERROR] ${new Date().toISOString()} ${msg}${formatMeta(meta)}`);
    },
    child(context) {
        // very small "child" emulation: returns a logger that prefixes messages with context
        const prefix = JSON.stringify(context);
        return {
            debug: (m, meta) => logger.debug(`${prefix} ${m}`, meta),
            info: (m, meta) => logger.info(`${prefix} ${m}`, meta),
            warn: (m, meta) => logger.warn(`${prefix} ${m}`, meta),
            error: (m, meta) => logger.error(`${prefix} ${m}`, meta)
        };
    }
};
exports.default = logger;
