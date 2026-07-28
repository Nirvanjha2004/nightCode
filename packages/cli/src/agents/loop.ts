import { ContextBuilder } from "./context";
import { MessageManager } from "./messages";
import { ToolRegistry } from "./registry";
import type { MessageType } from "./types";


export class AgentLoop {
    constructor(
        private contextBuilder: ContextBuilder,
        private messageManager: MessageManager,
        private toolRegistry: ToolRegistry,
        private llm: any
    ) {}

    async run(
        sessionId: string,
        userInput: string
    ) {

        // 1. Store user message
        this.messageManager.add({
            messageId: crypto.randomUUID(),
            sessionId,
            role: "user",
            content: userInput,
            createdAt: new Date()
        });


        while (true) {

            // 2. Build context for LLM
            const context =
                this.contextBuilder.build(sessionId);


            // 3. Send context to LLM
            const response =
                await this.llm.chat(context);



            // 4. Direct answer
            if (response.type === "text") {

                this.messageManager.add({
                    messageId: crypto.randomUUID(),
                    sessionId,
                    role: "assistant",
                    content: response.content,
                    createdAt: new Date()
                });


                return response.content;
            }



            // 5. Tool call
            if (response.type === "tool_call") {

                const tool =
                    this.toolRegistry.get(
                        response.toolCall.name
                    );


                if (!tool) {
                    throw new Error(
                        `Tool ${response.toolCall.name} not found`
                    );
                }


                const result =
                    await tool.exec(
                        response.toolCall.args
                    );

                // 6. Save tool result
                this.messageManager.add({
                    messageId: crypto.randomUUID(),
                    sessionId,
                    role: "tool",
                    content: result,
                    createdAt: new Date()
                });

            }
        }
    }
}