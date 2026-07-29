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

export const read: Tool = {
    name: "read",
    description: "Read the full contents of a file",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Absolute or relative path to the file" },
        },
        required: ["file"],
    },
    exec: async (args) => {
        const log = toolLogger("read");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string };
        try {
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
    description: "Write content to a file, overwriting if it exists",
    parameters: {
        type: "object",
        properties: {
            file:    { type: "string", description: "Path to the file" },
            content: { type: "string", description: "Content to write" },
        },
        required: ["file", "content"],
    },
    exec: async (args) => {
        const log = toolLogger("write");
        log.start(args);
        const start = Date.now();
        const { file, content } = args as { file: string; content: string };
        try {
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
    description: "Append text to the end of a file",
    parameters: {
        type: "object",
        properties: {
            file:    { type: "string", description: "Path to the file" },
            content: { type: "string", description: "Content to append" },
        },
        required: ["file", "content"],
    },
    exec: async (args) => {
        const log = toolLogger("append");
        log.start(args);
        const start = Date.now();
        const { file, content } = args as { file: string; content: string };
        try {
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
    description: "Replace a specific string inside a file",
    parameters: {
        type: "object",
        properties: {
            file:    { type: "string", description: "Path to the file" },
            oldText: { type: "string", description: "Exact text to find and replace" },
            newText: { type: "string", description: "Text to replace it with" },
        },
        required: ["file", "oldText", "newText"],
    },
    exec: async (args) => {
        const log = toolLogger("edit");
        log.start(args);
        const start = Date.now();
        const { file, oldText, newText } = args as { file: string; oldText: string; newText: string };
        try {
            const content = await readFile(file, "utf8");
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
    description: "Delete a file",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "Path to the file to delete" },
        },
        required: ["file"],
    },
    exec: async (args) => {
        const log = toolLogger("delete");
        log.start(args);
        const start = Date.now();
        const { file } = args as { file: string };
        try {
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
    description: "Create a directory, including any missing parent directories",
    parameters: {
        type: "object",
        properties: {
            dir: { type: "string", description: "Path of the directory to create" },
        },
        required: ["dir"],
    },
    exec: async (args) => {
        const log = toolLogger("mkdir");
        log.start(args);
        const start = Date.now();
        const { dir } = args as { dir: string };
        try {
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
    description: "List the contents of a directory",
    parameters: {
        type: "object",
        properties: {
            dir: { type: "string", description: "Path to the directory" },
        },
        required: ["dir"],
    },
    exec: async (args) => {
        const log = toolLogger("ls");
        log.start(args);
        const start = Date.now();
        const { dir } = args as { dir: string };
        try {
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
    description: "Find files matching a glob pattern",
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Glob pattern e.g. src/**/*.ts" },
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
    description: "Recursively find files by name under a root directory",
    parameters: {
        type: "object",
        properties: {
            root: { type: "string", description: "Directory to search from" },
            name: { type: "string", description: "File name to search for e.g. index.ts" },
        },
        required: ["root", "name"],
    },
    exec: async (args) => {
        const log = toolLogger("find");
        log.start(args);
        const start = Date.now();
        const { root, name } = args as { root: string; name: string };
        try {
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
    description: "Rename or move a file",
    parameters: {
        type: "object",
        properties: {
            from: { type: "string", description: "Current file path" },
            to:   { type: "string", description: "New file path" },
        },
        required: ["from", "to"],
    },
    exec: async (args) => {
        const log = toolLogger("rename");
        log.start(args);
        const start = Date.now();
        const { from, to } = args as { from: string; to: string };
        try {
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
    description: "Copy a file to a new location",
    parameters: {
        type: "object",
        properties: {
            from: { type: "string", description: "Source file path" },
            to:   { type: "string", description: "Destination file path" },
        },
        required: ["from", "to"],
    },
    exec: async (args) => {
        const log = toolLogger("copy");
        log.start(args);
        const start = Date.now();
        const { from, to } = args as { from: string; to: string };
        try {
            await copyFile(from, to);
            log.success(`Copied ${from} → ${to}`, Date.now() - start);
            return `Copied ${from} -> ${to}`;
        } catch (err) {
            log.error(err);
            throw err;
        }
    },
};