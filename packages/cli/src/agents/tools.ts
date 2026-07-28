import { readFile, writeFile } from "node:fs/promises";
import type { Tool, readArgs, writeArgs } from "./types";

export const read: Tool<readArgs> = {
    name: "read",
    description: "Read the contents of a file",

    exec: async ({ file }) => {
        try {
            const content = await readFile(file, "utf-8");
            return content;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to read "${file}": ${error.message}`);
            }
            throw new Error(`Failed to read "${file}".`);
        }
    },
};

export const write: Tool<writeArgs> = {
    name: "write",
    description: "Write content to a file",

    exec: async ({ file, content }) => {
        try {
            await writeFile(file, content, "utf-8");
            return `Successfully wrote to "${file}".`;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to write "${file}": ${error.message}`);
            }
            throw new Error(`Failed to write "${file}".`);
        }
    },
};