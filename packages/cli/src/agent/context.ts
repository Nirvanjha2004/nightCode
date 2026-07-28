import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";  
import type { ContextType } from "./types";


export class ContextBuilder {
    constructor(
        private messageManager: MessageManager,
        private sessionManager: SessionManager,
        private toolRegistry: ToolRegistry
    ) {}

    build(sessionId: string): ContextType {

        const session = this.sessionManager.get(sessionId);

        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const messages = this.messageManager.get(sessionId);

        const tools = this.toolRegistry.list();

        return {
            sessionId,
            model: session.model,
            messages,
            tools,
            systemPrompt: `
                You are a helpful terminal AI agent.
                You can read, write and modify files.
            `,
        };
    }
}