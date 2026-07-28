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
import path from "node:path";

import type {
    Tool,
    ReadArgs,
    WriteArgs,
    EditArgs,
    AppendArgs,
    DeleteArgs,
    MkdirArgs,
    LsArgs,
    GlobArgs,
    FindArgs,
    RenameArgs,
    CopyArgs,
} from "./types";

export const read: Tool<ReadArgs> = {
    name: "read",
    description: "Read a file",

    exec: async ({ file }) => {
        return await readFile(file, "utf8");
    },
};

export const write: Tool<WriteArgs> = {
    name: "write",
    description: "Write a file",

    exec: async ({ file, content }) => {
        await writeFile(file, content, "utf8");
        return `Wrote ${file}`;
    },
};

export const append: Tool<AppendArgs> = {
    name: "append",
    description: "Append text to a file",

    exec: async ({ file, content }) => {
        await appendFile(file, content, "utf8");
        return `Appended to ${file}`;
    },
};

export const del: Tool<DeleteArgs> = {
    name: "delete",
    description: "Delete a file",

    exec: async ({ file }) => {
        await unlink(file);
        return `Deleted ${file}`;
    },
};

export const makeDir: Tool<MkdirArgs> = {
    name: "mkdir",
    description: "Create a directory",

    exec: async ({ dir }) => {
        await mkdir(dir, { recursive: true });
        return `Created ${dir}`;
    },
};

export const ls: Tool<LsArgs> = {
    name: "ls",
    description: "List directory contents",

    exec: async ({ dir }) => {
        const files = await readdir(dir);

        return files.join("\n");
    },
};

export const globTool: Tool<GlobArgs> = {
    name: "glob",
    description: "Find files matching a glob pattern",

    exec: async ({ pattern }) => {
        const files = await glob(pattern);

        return files.join("\n");
    },
};

export const find: Tool<FindArgs> = {
    name: "find",
    description: "Find files by name",

    exec: async ({ root, name }) => {
        const files = await glob(`**/${name}`, {
            cwd: root,
        });

        return files.join("\n");
    },
};

export const renameTool: Tool<RenameArgs> = {
    name: "rename",
    description: "Rename or move a file",

    exec: async ({ from, to }) => {
        await rename(from, to);

        return `Renamed ${from} -> ${to}`;
    },
};

export const copy: Tool<CopyArgs> = {
    name: "copy",
    description: "Copy a file",

    exec: async ({ from, to }) => {
        await copyFile(from, to);

        return `Copied ${from} -> ${to}`;
    },
};


export const edit: Tool<EditArgs> = {
    name: "edit",
    description: "Replace text inside a file",

    exec: async ({ file, oldText, newText }) => {
        const content = await readFile(file, "utf8");

        const updated = content.replace(oldText, newText);

        await writeFile(file, updated, "utf8");

        return `Edited ${file}`;
    },
};