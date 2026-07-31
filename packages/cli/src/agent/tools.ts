import {
    readFile,
    writeFile,
    appendFile,
    unlink,
    mkdir,
    readdir,
    rename,
    copyFile,
} from "node:fs/promises";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

import { glob } from "glob";
import type { Tool } from "./types";
import { logger } from "../logger";
import os from "node:os";

const execAsync = promisify(exec);


const shell =
    os.platform() === "win32"
        ? "powershell.exe"
        : "bash";

// Safety nets for shell execution: a hung command must not stall the agent loop
// forever, and a huge log dump must not blow up memory.
const SHELL_TIMEOUT_MS   = 120_000; // 2 min default; overridable via the `timeout` arg
const SHELL_MAX_BUFFER   = 10 * 1024 * 1024; // 10MB of combined output

function toolLogger(name: string) {
    return {
        start(args: Record<string, unknown>) {
            logger.debug(`[Tool:${name}] started`, { args });
        },
        success(result: unknown, durationMs: number) {
            const summary = typeof result === "string" ? result.slice(0, 100) : JSON.stringify(result).slice(0, 100);
            logger.info(`[Tool:${name}] completed in ${durationMs}ms`, { resultPreview: summary, durationMs });
        },
        error(err: unknown) {
            logger.error(`[Tool:${name}] failed: ${err instanceof Error ? err.message : String(err)}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
        },
    };
}

// --- Guard: the memory/ directory is managed exclusively by the background
// memory-extraction pipeline. No tool may read, write, list, or otherwise
// touch it directly — this prevents the model from improvising its own
// memory-management logic and corrupting the automated store.
const MEMORY_PATH_PATTERN = /(^|[\\/])memory([\\/]|$)/i;

function assertNotMemoryPath(...paths: string[]): void {
    for (const p of paths) {
        if (p && MEMORY_PATH_PATTERN.test(p)) {
            throw new Error(
                `Access denied: "${p}" is inside the memory/ directory, which is managed automatically by the system and cannot be accessed by tools.`
            );
        }
    }
}

// --- Guard: some models occasionally emit a JSON object instead of a string
// for content-bearing parameters. Coerce defensively rather than crash.
function coerceToString(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
}

// ── Destructive command detection (for the bash tool) ─────────────────────
// If a shell command matches any of these patterns, the agent pauses and asks
// the user to confirm before executing it. This is a heuristic, not a security
// boundary — an unrecognized command can still be harmful, so the confirmation
// prompt is the real safety net.
// ponytail: regex heuristic — list is intentionally focused on irreversible ops
// (deletes, overwrites, force pushes, disk/DB wipes); if it grows long it should
// move to a curated data file rather than inline code.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
    /\brm\b/,                                            // rm anything (single file, -r, -rf, -f ...)
    /\brmdir\b/,                                         // remove directory
    /\bunlink\b/,
    /\bmv\b/,                                            // can silently overwrite the destination
    /\bcp\s+-[a-zA-Z]*f/i,                               // cp -f overwrites
    /\bshred\b/, /\bwipe\b/,
    /\bdd\b.*\bof=\/dev\//,                             // raw write to a device
    /\b(?:mkfs(?:\.[a-z0-9]+)?|format|fdisk|parted)\b/,
    /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--|push\s+--force|push\s+-f|branch\s+-[dD]|stash\s+drop|tag\s+-d)/,
    /\b(?:drop|truncate)\s+(?:database|table|schema)\b/i,
    /\bdelete\s+from\b/i,                                // unqualified DELETE wipes rows
    /\bkill\s+-9\b/i, /\bpkill\b/i, /\bkillall\b/i,
    /\b(?:shutdown|reboot|poweroff|halt)\b/i,
    /\binit\s+[06]\b/i,
    /\bsystemctl\s+(?:stop|disable|mask)\b/i,
    /\b(?:curl|wget)\b.*\|\s*(?:ba)?sh\b/i,             // pipe-to-shell execution
    /:\s*\(\s*\)\s*\{\s*:\|:&\s*\};:/,             // fork bomb
    /\bchmod\s+(-[a-zA-Z]*R)?\s*777\b/i,                // world-writable permissions
    /\bchown\s+-R\b/i,
    /\bcrontab\s+-r\b/i,
    /\bsed\s+-i/i,                                        // in-place file modification
    /\bfind\b.*\s-delete\b/,                             // find -delete
    /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm|network\s+rm|image\s+rm)\b/i,
    /\bnpm\s+(?:unpublish|cache\s+clean\s+--force)\b/i,
];

export function isDestructiveCommand(command: string): boolean {
    if (!command) return false;
    return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// Formats a shell run as a compact, LLM-readable result: command, output, exit code.
// Output is capped so a single huge log can't overflow the LLM context window
// (the context manager only compresses messages outside the preserved last 15).
// Keeps head + tail: test failures and conclusions usually live at the END of the
// output, so a plain head-truncation would hide exactly what the model needs.
const MAX_RESULT_CHARS = 12_000;
const TAIL_KEEP_CHARS  = 3_000;

export function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    const tail = text.slice(-TAIL_KEEP_CHARS);
    return `${text.slice(0, max - TAIL_KEEP_CHARS)}\n... (truncated, ${text.length} chars total) ...\n${tail}`;
}

function formatShellResult(
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number,
    signal?: string | null
): string {
    const parts: string[] = [`$ ${command}`];
    const out = truncate((stdout ?? "").trimEnd(), MAX_RESULT_CHARS);
    const err = truncate((stderr ?? "").trimEnd(), MAX_RESULT_CHARS);
    if (out) parts.push(`--- stdout ---\n${out}`);
    if (err) parts.push(`--- stderr ---\n${err}`);
    if (!out && !err) parts.push("(no output)");
    parts.push(`exit code: ${exitCode}${signal ? ` (killed by ${signal})` : ""} — took ${durationMs}ms`);
    return parts.join("\n");
}

export const read: Tool = {
    name: "read",
    description:
        "Read and return the full text contents of a single file at the given path. " +
        "Use this before editing any existing file, and whenever you need to inspect a file's " +
        "current content rather than assuming it. Works only on text-readable files (source code, " +
        "JSON, markdown, config files, etc.) — do not use on binary files (images, executables, archives). " +
        "Path can be relative to the current working directory or absolute. " +
        "Throws an error if the file does not exist or cannot be read — check with `ls`, `glob`, or `find` first if unsure the path is correct. " +
        "Note: files inside the memory/ directory are off-limits and cannot be read with this tool.",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Relative or absolute path to the file to read, e.g. \"src/index.ts\"" },
        },
        required: ["file"],
    },
    exec: async (args) => {
        const log = toolLogger("read");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string };
        try {
            assertNotMemoryPath(file);
            const content = await readFile(file, "utf8");
            log.success(`${content.length} chars`, Date.now() - start);
            return content;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const write: Tool = {
    name: "write",
    destructive: true,
    description:
        "Create a new file with the given content, or completely overwrite an existing file if it already exists. " +
        "This replaces the ENTIRE file — any content not included in `content` will be lost. " +
        "Use this only when creating a brand-new file, or when a full rewrite is genuinely necessary " +
        "(e.g. the file's structure is changing substantially). For small, targeted changes to an existing " +
        "file, prefer the `edit` tool instead, since it is safer and preserves everything else in the file. " +
        "`content` must always be a plain string — if you are writing structured data (JSON, config objects), " +
        "convert it to a string first (e.g. JSON.stringify) rather than passing an object or array directly. " +
        "Note: the memory/ directory cannot be written to with this tool; it is managed automatically by the system.",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Relative or absolute path to the file to create or overwrite" },
            content: { type: "string", description: "The full text content to write, as a plain string (stringify any JSON/objects before passing)" },
        },
        required: ["file", "content"],
    },
    exec: async (args) => {
        const log = toolLogger("write");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string; content: unknown };
        const content = coerceToString((args as any).content);
        try {
            assertNotMemoryPath(file);
            await writeFile(file, content, "utf8");
            log.success(`Wrote ${file} (${content.length} chars)`, Date.now() - start);
            return `Wrote ${file}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const append: Tool = {
    name: "append",
    description:
        "Add content to the end of an existing file without modifying anything already in it. " +
        "If the file does not exist, it will typically be created (depending on the filesystem), but " +
        "this tool is intended for adding to files that already exist — e.g. adding a new log line, " +
        "a new entry to a list, or a new section to a growing document. " +
        "`content` must always be a plain string — if appending structured data (JSON), stringify it first " +
        "rather than passing a raw object. " +
        "Note: the memory/ directory cannot be appended to with this tool; it is managed automatically by the system.",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Relative or absolute path to the file to append to" },
            content: { type: "string", description: "The text to add to the end of the file, as a plain string (stringify any JSON/objects before passing)" },
        },
        required: ["file", "content"],
    },
    exec: async (args) => {
        const log = toolLogger("append");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string; content: unknown };
        const content = coerceToString((args as any).content);
        try {
            assertNotMemoryPath(file);
            await appendFile(file, content, "utf8");
            log.success(`Appended ${content.length} chars to ${file}`, Date.now() - start);
            return `Appended to ${file}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const edit: Tool = {
    name: "edit",
    destructive: true,
    description:
        "Make a targeted, surgical change inside an existing file by replacing one exact occurrence of `oldText` " +
        "with `newText`. This is the PREFERRED way to modify an existing file — safer than `write`, since it " +
        "leaves everything else in the file untouched. `oldText` must match the file's current content EXACTLY, " +
        "including whitespace, indentation, and line breaks — if you are not certain of the exact text, use `read` " +
        "first to confirm it before calling this tool. If `oldText` does not appear in the file (or appears in a way " +
        "that causes an unintended match), the edit may silently do nothing or replace the wrong occurrence — read " +
        "the file back afterward to verify the change took effect as expected. " +
        "`oldText` and `newText` must always be plain strings, not JSON objects. " +
        "Note: files inside the memory/ directory cannot be edited with this tool.",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Relative or absolute path to the file to edit" },
            oldText: { type: "string", description: "The exact existing text to find (must match whitespace/indentation exactly)" },
            newText: { type: "string", description: "The text to replace it with, as a plain string" },
        },
        required: ["file", "oldText", "newText"],
    },
    exec: async (args) => {
        const log = toolLogger("edit");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string; oldText: unknown; newText: unknown };
        const oldText = coerceToString((args as any).oldText);
        const newText = coerceToString((args as any).newText);
        try {
            assertNotMemoryPath(file);
            const content = await readFile(file, "utf8");
            if (!content.includes(oldText)) {
                throw new Error(`oldText not found in ${file} — read the file first to confirm the exact text.`);
            }
            const updated = content.replace(oldText, newText);
            await writeFile(file, updated, "utf8");
            const diffLen = Math.abs(updated.length - content.length);
            log.success(`Edited ${file} (${diffLen} char delta)`, Date.now() - start);
            return `Edited ${file}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const del: Tool = {
    name: "delete",
    destructive: true,
    description:
        "Permanently delete a single file. This action is irreversible — there is no undo or recycle bin. " +
        "Only use this when the target file has been explicitly confirmed (e.g. via a prior `ls`, `read`, or " +
        "`find` call, or because the user gave an extremely explicit exact path) — never guess a path for deletion. " +
        "Do not use this on files you have not verified exist and are correct, and never use it speculatively. " +
        "Note: files inside the memory/ directory cannot be deleted with this tool; it is managed automatically by the system.",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Relative or absolute path to the file to permanently delete" },
        },
        required: ["file"],
    },
    exec: async (args) => {
        const log = toolLogger("delete");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string };
        try {
            assertNotMemoryPath(file);
            await unlink(file);
            log.success(`Deleted ${file}`, Date.now() - start);
            return `Deleted ${file}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const makeDir: Tool = {
    name: "mkdir",
    description:
        "Create a new directory at the given path, including any missing parent directories along the way " +
        "(equivalent to `mkdir -p`). Safe to call even if the directory already exists — it will not error " +
        "or overwrite anything in that case. Use this before writing files into a directory structure that " +
        "may not exist yet. " +
        "Note: the memory/ directory tree is managed automatically by the system and cannot be created/modified with this tool.",
    parameters: {
        type: "object",
        properties: {
            dir: { type: "string", description: "Relative or absolute path of the directory to create" },
        },
        required: ["dir"],
    },
    exec: async (args) => {
        const log = toolLogger("mkdir");
        log.start(args);
        const start = Date.now();
        const { dir } = args as { dir: string };
        try {
            assertNotMemoryPath(dir);
            await mkdir(dir, { recursive: true });
            log.success(`Created ${dir}`, Date.now() - start);
            return `Created ${dir}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const ls: Tool = {
    name: "ls",
    description:
        "List the immediate contents (files and subdirectories) of a directory, one entry per line. " +
        "This is a shallow, single-level listing — it does not recurse into subdirectories. " +
        "Use this to check what exists in a location before assuming a file is (or isn't) there, or to " +
        "discover what's inside a directory you haven't inspected yet. For finding files by name or pattern " +
        "across nested directories, prefer `glob` or `find` instead. " +
        "Note: the memory/ directory cannot be listed with this tool; it is managed automatically by the system.",
    parameters: {
        type: "object",
        properties: {
            dir: { type: "string", description: "Relative or absolute path to the directory to list" },
        },
        required: ["dir"],
    },
    exec: async (args) => {
        const log = toolLogger("ls");
        log.start(args);
        const start = Date.now();
        const { dir } = args as { dir: string };
        try {
            assertNotMemoryPath(dir);
            const files = await readdir(dir);
            log.success(`${files.length} entries`, Date.now() - start);
            return files.join("\n");
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const globTool: Tool = {
    name: "glob",
    description:
        "Find all files matching a glob pattern, searched relative to the current working directory. " +
        "Supports standard glob syntax including `**` for recursive matching across nested directories " +
        "(e.g. \"src/**/*.ts\" matches all .ts files anywhere under src/, \"*.json\" matches only top-level " +
        "JSON files). Use this when you know the file extension or naming pattern but not the exact location, " +
        "or need to gather multiple matching files at once. For finding a specific file by exact name, `find` " +
        "may be more direct. Returns one matching path per line, or an empty result if nothing matches. " +
        "Note: results from inside the memory/ directory are not accessible via other tools even if matched here.",
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Glob pattern to match, e.g. \"src/**/*.ts\" or \"*.md\"" },
        },
        required: ["pattern"],
    },
    exec: async (args) => {
        const log = toolLogger("glob");
        log.start(args);
        const start = Date.now();
        const { pattern } = args as { pattern: string };
        try {
            const files = await glob(pattern);
            log.success(`${files.length} matches`, Date.now() - start);
            return files.join("\n");
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const find: Tool = {
    name: "find",
    description:
        "Recursively search under a root directory for files whose name matches the given `name`, at any depth. " +
        "Use this when you know (or can guess) a file's exact name but not which directory it lives in — " +
        "e.g. finding \"package.json\" somewhere under a project root. If multiple matches are found and it's " +
        "ambiguous which one the user means, list them and ask for clarification rather than picking one arbitrarily, " +
        "unless the correct choice is obvious from context. Returns one matching relative path per line. " +
        "Note: this cannot be used to search inside the memory/ directory.",
    parameters: {
        type: "object",
        properties: {
            root: { type: "string", description: "Directory to search from, e.g. \".\" or \"src\"" },
            name: { type: "string", description: "Exact file name to search for, e.g. \"index.ts\" or \"config.json\"" },
        },
        required: ["root", "name"],
    },
    exec: async (args) => {
        const log = toolLogger("find");
        log.start(args);
        const start = Date.now();
        const { root, name } = args as { root: string; name: string };
        try {
            assertNotMemoryPath(root);
            const files = await glob(`**/${name}`, { cwd: root });
            log.success(`${files.length} matches`, Date.now() - start);
            return files.join("\n");
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

// ── grep (ripgrep) ────────────────────────────────────────────────────────
// Builds the ripgrep argv from tool args. Pure function so it can be
// unit-checked without spawning a process.
// ponytail: arg list is hand-rolled for the handful of options the model needs;
// if more flags (context lines, fixed strings, ...) are wanted, extend the map here.
export function buildRipgrepArgs(args: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    maxResults?: number;
}): string[] {
    const rgArgs = [
        "--line-number",
        "--no-heading",       // one `path:line:content` per match, no grouping headers
        "--color", "never",
        // The memory/ directory is off-limits to tools — never surface its contents.
        "-g", "!**/memory/**",
    ];
    if (args.ignoreCase) rgArgs.push("-i");
    if (args.glob) rgArgs.push("-g", String(args.glob));
    const m = args.maxResults;
    if (typeof m === "number" && Number.isFinite(m) && m > 0) {
        rgArgs.push("-m", String(Math.floor(Math.min(m, 1000)))); // cap per-file matches
    }
    // `--` ends flag parsing so a pattern (or path) starting with "-" is treated as text
    rgArgs.push("--", String(args.pattern));
    if (args.path) rgArgs.push(String(args.path));
    return rgArgs;
}

// Runs a command with an argv array and NO shell — quoting/escaping surprises
// (spaces, $, backticks, Windows/powershell rules) simply can't happen. Captures
// combined output with a hard size cap and kills on timeout, mirroring the bash tool.
function runProcess(
    cmd: string,
    args: string[],
    timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string; signal: string | null }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        let finished = false;
        const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        const finish = (code: number, signal: string | null) => {
            if (finished) return;
            finished = true;
            clearTimeout(killTimer);
            resolve({ code, stdout, stderr, signal });
        };
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            if (stdout.length > SHELL_MAX_BUFFER) child.kill("SIGKILL");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) => {
            stderr += `failed to spawn ${cmd}: ${err.message}`;
            finish(127, null);
        });
        child.on("close", (code, signal) => finish(code ?? 1, signal));
    });
}

export const grep: Tool = {
    name: "grep",
    description:
        "Search the CONTENTS of files using ripgrep (rg), the fast recursive grep. " +
        "Use this to find every file and line matching a regex pattern — all call sites of a " +
        "function, all TODO/FIXME comments, or where a string appears anywhere in the project. " +
        "Returns one `path:line:content` per match. The pattern is a regular expression in " +
        "ripgrep syntax. By default it searches the current directory recursively and honors " +
        ".gitignore; pass `path` to limit the search to a specific file or directory, and `glob` " +
        "to restrict which files are searched (e.g. \"*.ts\", \"!*.test.ts\"). When nothing matches, " +
        "the result says \"exit code: 1\" — that is ripgrep's normal empty-result convention, not an " +
        "error. For finding files by NAME rather than content, use `find` or `glob` instead. " +
        "Note: the memory/ directory is always excluded from search results.",
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regex pattern to search for, e.g. \"createUser\" or \"TODO|FIXME\"" },
            path: { type: "string", description: "Optional file or directory to search instead of the whole project, e.g. \"src\" or \"package.json\"" },
            glob: { type: "string", description: "Optional glob filter for which files to search, e.g. \"*.ts\" or \"!*.test.ts\"" },
            ignoreCase: { type: "boolean", description: "If true, match case-insensitively" },
            maxResults: { type: "number", description: "Optional cap on matches per file (default: unlimited)" },
        },
        required: ["pattern"],
    },
    exec: async (args) => {
        const log = toolLogger("grep");
        log.start(args);
        const start = Date.now();
        const pattern = coerceToString((args as any).pattern);
        if (!pattern) {
            return "Error: no pattern provided.";
        }
        const rgArgs = buildRipgrepArgs(args as any);
        try {
            const { code, stdout, stderr, signal } = await runProcess("rg", rgArgs, SHELL_TIMEOUT_MS);
            const result = formatShellResult(`rg ${rgArgs.join(" ")}`, stdout, stderr, code, Date.now() - start, signal);
            log.success(`exit ${code} in ${Date.now() - start}ms`, Date.now() - start);
            return result;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const renameTool: Tool = {
    name: "rename",
    destructive: true,
    description:
        "Rename a file, or move it to a new path (renaming and moving are the same operation on most filesystems). " +
        "The destination's parent directory must already exist — use `mkdir` first if it doesn't. " +
        "Before renaming, make sure the source path is correct (e.g. verified via a prior `ls` or `find` call), " +
        "since an incorrect source path will fail, and an incorrect destination could silently overwrite another file. " +
        "Note: this cannot be used to move files into or out of the memory/ directory.",
    parameters: {
        type: "object",
        properties: {
            from: { type: "string", description: "Current path of the file" },
            to: { type: "string", description: "New path (or new name) for the file" },
        },
        required: ["from", "to"],
    },
    exec: async (args) => {
        const log = toolLogger("rename");
        log.start(args);
        const start = Date.now();
        const { from, to } = args as { from: string; to: string };
        try {
            assertNotMemoryPath(from, to);
            await rename(from, to);
            log.success(`Renamed ${from} → ${to}`, Date.now() - start);
            return `Renamed ${from} -> ${to}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

export const bash: Tool = {
    name: "bash",
    description:
        "Run a shell command in a bash subprocess and return its output. " +
        "Use this for anything command-line: running tests (e.g. \"pytest tests/ -q\"), builds, linters, " +
        "package installs, git operations, or any other command the user asks you to run. " +
        "The result includes captured stdout, stderr, and the exit code, so a failing command is " +
        "reported back to you (not an error) and you can react: fix the code, re-run the test, etc. " +
        "Commands run in the project's working directory. " +
        "WARNING: commands that delete or overwrite things (rm, mv, git reset --hard, drop table, ...) " +
        "trigger a user confirmation prompt. Do NOT try to work around that prompt, and do not run " +
        "destructive commands unless the user explicitly asked for them. " +
        "Do not run the same command repeatedly in a tight loop — run once, read the output, then decide. " +
        "Note: shell commands cannot access the memory/ directory; it is managed automatically by the system.",
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "The bash command to execute, e.g. \"pytest tests/ -q\"" },
            timeout: { type: "number", description: "Optional timeout in milliseconds (default 120000). Increase for long-running commands like full test suites." },
        },
        required: ["command"],
    },
    isDestructive: (args) => isDestructiveCommand(coerceToString((args as any).command)),
    exec: async (args) => {
        const log = toolLogger("bash");
        log.start(args);
        const start = Date.now();
        const command = coerceToString((args as any).command);
        if (!command) {
            return "$ bash\nError: no command provided.";
        }
        // Trust boundary: the model supplies `timeout`. 0/-1/NaN/Infinity would all
        // silently disable the safety net in Node's exec, so sanitize + clamp.
        const t = (args as any).timeout;
        const timeout =
            typeof t === "number" && Number.isFinite(t) && t > 0
                ? Math.min(t, 10 * 60_000)
                : SHELL_TIMEOUT_MS;

        try {
            assertNotMemoryPath(command);
            const { stdout, stderr } = await execAsync(command, {
                shell,
                timeout,
                maxBuffer: SHELL_MAX_BUFFER,
                windowsHide: true,
            });
            const result = formatShellResult(command, stdout, stderr, 0, Date.now() - start);
            log.success(`exit 0 in ${Date.now() - start}ms`, Date.now() - start);
            return result;
        } catch (err) {
            // Non-zero exit is a RESULT, not an exception — the model needs the
            // output to decide the next step. Same for timeouts/killed processes.
            const e = err as { code?: number; signal?: string; stdout?: string; stderr?: string; message?: string };
            const exitCode = typeof e.code === "number" ? e.code : 1;
            // Command-not-found (ENOENT) can reject with empty stderr but a useful message.
            const stderrRaw =
                typeof e.stderr === "string" && e.stderr.length > 0 ? e.stderr : (e.message ?? "");
            const result = formatShellResult(
                command,
                typeof e.stdout === "string" ? e.stdout : "",
                stderrRaw,
                exitCode,
                Date.now() - start,
                e.signal
            );
            log.success(`exit ${exitCode} in ${Date.now() - start}ms`, Date.now() - start);
            return result;
        }
    },
};

export const copy: Tool = {
    name: "copy",
    destructive: true,
    description:
        "Copy a file to a new location, leaving the original file untouched. If a file already exists at the " +
        "destination path, it will typically be overwritten — verify the destination is correct and intentional " +
        "before calling this, especially if you haven't confirmed via `ls` or `read` that overwriting is safe. " +
        "The destination's parent directory must already exist — use `mkdir` first if it doesn't. " +
        "Note: this cannot be used to copy files into or out of the memory/ directory.",
    parameters: {
        type: "object",
        properties: {
            from: { type: "string", description: "Path to the source file to copy" },
            to: { type: "string", description: "Destination path for the copy" },
        },
        required: ["from", "to"],
    },
    exec: async (args) => {
        const log = toolLogger("copy");
        log.start(args);
        const start = Date.now();
        const { from, to } = args as { from: string; to: string };
        try {
            assertNotMemoryPath(from, to);
            await copyFile(from, to);
            log.success(`Copied ${from} → ${to}`, Date.now() - start);
            return `Copied ${from} -> ${to}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};

// ── todoWrite ─────────────────────────────────────────────────────────────
// Stateless todo tracker: renders the checklist as the tool result, which the
// loop stores as a "tool" message — so the model sees its own plan in the
// conversation on later turns. Re-call with the FULL updated list on progress.
const TODO_MARKERS: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
};

export function renderTodoList(todos: Array<{ content: unknown; status?: unknown }>): string {
    if (!todos.length) return "Todo list cleared.";
    return todos
        .map((t, i) => {
            const status =
                t.status === "in_progress" || t.status === "completed" ? String(t.status) : "pending";
            return `${i + 1}. ${TODO_MARKERS[status]} ${coerceToString(t.content)}`;
        })
        .join("\n");
}

export const todoWrite: Tool = {
    name: "todoWrite",
    description:
        "Record the plan for a multi-step task as a checklist, and keep it updated as work progresses. " +
        "Call this at the START of any task with multiple steps, and re-call it whenever a step's status " +
        "changes — always pass the FULL updated list, never a diff. Each item has `content` (what to do) " +
        "and `status`, one of \"pending\", \"in_progress\", or \"completed\". The rendered checklist is " +
        "returned to you in the conversation, so you can see the current plan on later turns. Pass an " +
        "empty list to clear the plan. Keep items short and actionable.",
    parameters: {
        type: "object",
        properties: {
            todos: {
                type: "array",
                description:
                    "The full plan as an array of objects, each shaped like { content: string, status: \"pending\" | \"in_progress\" | \"completed\" }",
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "What to do" },
                        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    },
                    required: ["content", "status"],
                },
            },
        },
        required: ["todos"],
    },
    exec: async (args) => {
        const log = toolLogger("todoWrite");
        log.start(args);
        const start = Date.now();
        const raw = (args as any).todos;
        const todos = Array.isArray(raw) ? raw : [];
        const result = renderTodoList(todos);
        log.success(`${todos.length} todos rendered`, Date.now() - start);
        return result;
    },
};