import type { Tool } from "./types";
import { logger } from "../logger";

export class ToolRegistry {
    private tools = new Map<string, Tool>();

    register(tool: Tool) {
        this.tools.set(tool.name, tool);
        logger.info(`[Registry] Registered tool: "${tool.name}"`);
    }

    get(name: string) {
        const tool = this.tools.get(name);
        if (!tool) {
            logger.warn(`[Registry] Tool not found: "${name}"`);
        }
        return tool;
    }

    has(name: string) {
        return this.tools.has(name);
    }

    list() {
        const tools = [...this.tools.values()];
        logger.debug(`[Registry] List — ${tools.length} tool(s) registered`);
        return tools;
    }
}