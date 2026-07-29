import type { ContextBuilder } from "./context";
import type { MessageManager } from "./messages";
import type { ToolRegistry } from "./registry";
import type { SessionManager } from "./session";
import type { Tool } from "./types";
import { logger } from "../logger";

export class AgentHarness {
    constructor(
        public messageManager: MessageManager,
        public sessionManager: SessionManager,
        public toolRegistry: ToolRegistry,
        public contextBuilder: ContextBuilder,
    ) {
        logger.debug("AgentHarness constructed");
    }

    // Convenience method to register tools directly via harness
    registerTool(tool: Tool): void {
        logger.info(`[Harness] Registering tool: ${tool.name}`);
        this.toolRegistry.register(tool);
    }

    // Convenience method to create a session directly via harness
    createSession(model: string): string {
        logger.info(`[Harness] Creating session with model: ${model}`);
        const sessionId = this.sessionManager.create({ model });
        logger.debug(`[Harness] Session created: ${sessionId}`);
        return sessionId;
    }
}