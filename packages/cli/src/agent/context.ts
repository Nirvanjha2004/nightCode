import Groq from "groq-sdk";
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

        // Map internal Tool → Groq's ChatCompletionTool shape here
        const tools: Groq.Chat.Completions.ChatCompletionTool[] = this.toolRegistry
            .list()
            .map((tool) => ({
                type: "function" as const,   // required by Groq, missing from your Tool type
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters, // JSON schema Groq uses to fill args
                },
            }));

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