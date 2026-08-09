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

    /**
     * All tools when `allowedNames` is undefined; otherwise only the tools
     * whose name is in `allowedNames`. Unknown names are simply ignored.
     */
    listFiltered(allowedNames?: string[]): Tool[] {
        if (allowedNames === undefined) {
            return this.list();
        }
        const allowed = new Set(allowedNames);
        const tools = [...this.tools.values()].filter((tool) => allowed.has(tool.name));
        logger.debug(`[Registry] List filtered — ${tools.length}/${this.tools.size} tool(s) exposed`);
        return tools;
    }
}