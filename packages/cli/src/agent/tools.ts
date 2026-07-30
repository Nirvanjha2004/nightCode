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

import { glob } from "glob";
import type { Tool } from "./types";
import { logger } from "../logger";

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

export const renameTool: Tool = {
    name: "rename",
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

export const copy: Tool = {
    name: "copy",
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