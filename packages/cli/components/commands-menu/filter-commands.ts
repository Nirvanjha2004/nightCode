import type { Command } from "./types";

export function getFiltererdCommands(query: string, commands: Command[]): Command[] {
    if (query.length === 0) return commands;
    return commands.filter((cmd) => cmd.value.toLowerCase().startsWith(query.toLowerCase()));
}