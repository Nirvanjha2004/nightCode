// Tools

import type { Tool , readArgs, writeArgs} from "./types";

export const read : Tool<readArgs> = {
    name : "read",
    description : "Read a file",
    exec : async (args : readArgs) => {
        return `Read file ${args.file}`;
    }
}
export const write : Tool<writeArgs> = {
    name : "write",
    description : "Write a file",
    exec : async (args : writeArgs) => {
        return `Write file ${args.file} with content ${args.content}`;
    }
}