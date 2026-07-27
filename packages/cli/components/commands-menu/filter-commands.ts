import { COMMANDS } from "./commands";
import type { Command } from "./types";

export function getFiltererdCommands(query : string) : Command[]{
    if(query.length == 0) return COMMANDS;
    return COMMANDS.filter((cmd) => cmd.value.toLowerCase().startsWith(query.toLowerCase())); 
}