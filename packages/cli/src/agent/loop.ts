import type { AgentHarness } from "./agent-harness";

export class AgentLoop {
    constructor(
        private harness: AgentHarness,
        private llm: any,
        private maxIterations: number = 10
    ) {}

    async execute(sessionId: string, userInput: string): Promise<string> {
        // Step 1: User message store karo
        this.harness.messageManager.add({
            sessionId,
            role: "user",
            content: userInput,
            createdAt: new Date(),
            messageId : crypto.randomUUID(),
        });

        for (let iter = 1; iter <= this.maxIterations; iter++) {
            // Step 2: Context build karo (Harness handles this)
            const context = this.harness.contextBuilder.build(sessionId);

            // Step 3: LLM call
            const response = await this.llm.chat(context);

            // Exit Condition: Natural text answer
            if (response.type === "text") {
                this.harness.messageManager.add({
                    sessionId,
                    role: "assistant",
                    content: response.content,
                    createdAt: new Date(),
                    messageId : crypto.randomUUID(),
                });
                return response.content;
            }

            // Step 4: Tool execution flow
            if (response.type === "tool_call") {
                // Save assistant intent
                this.harness.messageManager.add({
                    sessionId,
                    role: "assistant",
                    content: response.toolCall,
                    createdAt: new Date(),
                    messageId : crypto.randomUUID(),
                });

                // Run tool via ToolRegistry in Harness
                const tool = this.harness.toolRegistry.get(response.toolCall.name);
                const result = tool 
                    ? await tool.exec(response.toolCall.args) 
                    : `Error: Tool ${response.toolCall.name} missing`;

                // Save tool result
                this.harness.messageManager.add({
                    sessionId,
                    role: "tool",
                    content: result,
                    createdAt: new Date(),
                    messageId : crypto.randomUUID(),
                });
            }
        }

        throw new Error("Reached maximum loop iterations.");
    }
}