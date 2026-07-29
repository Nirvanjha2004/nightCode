import winston from "winston";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Log directory ───────────────────────────────────────────────────────────
// Can be overridden via LOG_DIR env var; defaults to <project-root>/logs
const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), "logs");
mkdirSync(LOG_DIR, { recursive: true });

// ── Formatters ──────────────────────────────────────────────────────────────

/** Structured JSON format used in file transports (machine-parseable) */
const jsonFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
);

/** Human-readable, colorized format used in the console transport */
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const rest = Object.keys(meta).length
            ? `  ${JSON.stringify(meta, null, 0)}`
            : "";
        return `${timestamp} ${level}: ${message}${rest}`;
    }),
);

// ── Logger instance ─────────────────────────────────────────────────────────

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "debug",
    format: jsonFormat,
    transports: [
        // Console ── all levels to stderr so they don't corrupt the TUI stdout
        new winston.transports.Console({
            format: consoleFormat,
            stderrLevels: [
                "error",
                "warn",
                "info",
                "http",
                "verbose",
                "debug",
                "silly",
            ],
        }),

        // Combined log file ── all levels, rotated at 5 MB
        new winston.transports.File({
            filename: join(LOG_DIR, "combined.log"),
            maxsize: 5 * 1024 * 1024,
            maxFiles: 5,
            tailable: true,
        }),

        // Error-only log file ── just errors + warnings for quick triage
        new winston.transports.File({
            filename: join(LOG_DIR, "error.log"),
            level: "warn",
            maxsize: 5 * 1024 * 1024,
            maxFiles: 5,
            tailable: true,
        }),
    ],
});

logger.info(`Logger initialized — writing to ${LOG_DIR}`);
