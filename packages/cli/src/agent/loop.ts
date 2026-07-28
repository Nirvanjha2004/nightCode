import { randomUUID } from "node:crypto";
import type { AgentHarness } from "./agent-harness";
import type { ToolCall } from "./types";

export class AgentLoop {
    constructor(
        private harness: AgentHarness,
        private llm: any,
        private maxIterations: number = 10
    ) { }

    async execute(sessionId: string, userInput: string): Promise<string> {
        // Step 1: User message store karo
        this.harness.messageManager.add({
            sessionId,
            role: "user",
            content: userInput,
            createdAt: new Date(),
            messageId: randomUUID(),
        });

        for (let iter = 1; iter <= this.maxIterations; iter++) {
            // Step 2: Context build karo
            const context = this.harness.contextBuilder.build(sessionId);

            // Step 3: LLM call
            const response = await this.llm.chat(context);

            // Exit condition: natural text answer
            if (response.type === "text") {
                this.harness.messageManager.add({
                    sessionId,
                    role: "assistant",
                    content: response.content,
                    createdAt: new Date(),
                    messageId: randomUUID(),
                });
                return response.content;
            }

            // Step 4: Tool call flow
            if (response.type === "tool_call") {
                const toolCalls: ToolCall[] = response.toolCalls;

                // Assistant intent — toolCalls is the plural array field
                this.harness.messageManager.add({
                    sessionId,
                    role: "assistant",
                    content: "",        // required by type, empty since intent is in toolCalls
                    toolCalls: toolCalls,          // ToolCall[] — matches updated MessageType
                    createdAt: new Date(),
                    messageId: randomUUID(),
                });

                // One tool result message per call
                for (const toolCall of toolCalls) {
                    let result: string;

                    try {
                        const tool = this.harness.toolRegistry.get(toolCall.name);

                        if (!tool) {
                            result = `Error: Tool "${toolCall.name}" is not registered.`;
                        } else {
                            const raw = await tool.exec(toolCall.args);
                            result = typeof raw === "string" ? raw : JSON.stringify(raw);
                        }
                    } catch (err) {
                        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                    }

                    // Tool result — only toolCallId needed here, no toolCalls field
                    this.harness.messageManager.add({
                        sessionId,
                        role: "tool",
                        content: result,
                        toolCallId: toolCall.id,  // links to assistant's toolCalls[i].id
                        createdAt: new Date(),
                        messageId: randomUUID(),
                    });
                }
            }
        }

        throw new Error("Reached maximum loop iterations.");
    }
}