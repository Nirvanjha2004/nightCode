import type { Tool } from "./types";

export class ToolRegistry {
    private tools = new Map<string, Tool<any>>();

    register(tool: Tool<any>) {
        this.tools.set(tool.name, tool);
    }

    get(name: string) {
        return this.tools.get(name);
    }

    has(name: string) {
        return this.tools.has(name);
    }

    list() {
        return [...this.tools.values()];
    }
}