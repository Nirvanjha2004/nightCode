import { join, resolve } from "node:path";

// Repo root (the nightCode folder) derived from THIS module's location
// (packages/cli/src → up three levels), not process.cwd(), so memory and
// logs always land in the root folder no matter which directory the CLI
// process is launched from.
export const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..", "..");

export const MEMORY_DIR = join(PROJECT_ROOT, "memory");
export const LOGS_DIR = join(PROJECT_ROOT, "logs");
