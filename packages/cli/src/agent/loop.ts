import { randomUUID } from "node:crypto";
import type { AgentHarness } from "./agent-harness";
import type { ToolCall } from "./types";
import { logger } from "../logger";

export class AgentLoop {
    constructor(
        private harness: AgentHarness,
        private llm: any,
        private maxIterations: number = 10
    ) { }

    async execute(sessionId: string, userInput: string): Promise<string> {
        logger.info(`[AgentLoop] Starting execution — session=${sessionId}`, {
            userInput: userInput.slice(0, 200),
        });

        // Step 1: Store user message
        this.harness.messageManager.add({
            sessionId,
            role: "user",
            content: userInput,
            createdAt: new Date(),
            messageId: randomUUID(),
        });
        logger.debug(`[AgentLoop] User message stored (len=${userInput.length})`);

        for (let iter = 1; iter <= this.maxIterations; iter++) {
            logger.info(`[AgentLoop] Iteration ${iter}/${this.maxIterations}`);

            // Step 2: Build context
            let context;
            try {
                context = this.harness.contextBuilder.build(sessionId);
                logger.debug(`[AgentLoop] Context built — ${context.messages.length} messages, ${context.tools.length} tools`);
            } catch (err) {
                logger.error(`[AgentLoop] Failed to build context: ${err instanceof Error ? err.message : String(err)}`, {
                    stack: err instanceof Error ? err.stack : undefined,
                });
                throw err;
            }

            // Step 3: LLM call
            let response;
            try {
                logger.info(`[AgentLoop] Sending to LLM (model=${context.model})`);
                response = await this.llm.chat(context);
                logger.debug(`[AgentLoop] LLM response type: ${response.type}`);
            } catch (err) {
                logger.error(`[AgentLoop] LLM call failed: ${err instanceof Error ? err.message : String(err)}`, {
                    stack: err instanceof Error ? err.stack : undefined,
                });
                throw err;
            }

            // Exit condition: natural text answer
            if (response.type === "text") {
                logger.info(`[AgentLoop] LLM returned text response (len=${response.content.length})`);

                this.harness.messageManager.add({
                    sessionId,
                    role: "assistant",
                    content: response.content,
                    createdAt: new Date(),
                    messageId: randomUUID(),
                });
                logger.debug(`[AgentLoop] Assistant message stored — returning response`);
                return response.content;
            }

            // Step 4: Tool call flow
            if (response.type === "tool_calls") {
                logger.info(`[AgentLoop] LLM requested ${JSON.stringify(response)} for tool call(s)`);

                const toolCalls: ToolCall[] = response.toolCalls;
                logger.info(`[AgentLoop] LLM requested ${toolCalls.length} tool call(s)`);

                // Log each tool call details
                for (const tc of toolCalls) {
                    logger.info(`[AgentLoop]   → Tool: ${tc.name} | id: ${tc.id}`, { args: tc.args });
                }

                // Assistant intent — toolCalls is the plural array field
                this.harness.messageManager.add({
                    sessionId,
                    role: "assistant",
                    content: "",
                    toolCalls: toolCalls,
                    createdAt: new Date(),
                    messageId: randomUUID(),
                });
                logger.debug(`[AgentLoop] Assistant tool-call message stored`);

                // Execute each tool call
                for (const toolCall of toolCalls) {
                    let result: string;
                    const startTime = Date.now();

                    try {
                        const tool = this.harness.toolRegistry.get(toolCall.name);

                        if (!tool) {
                            logger.warn(`[AgentLoop] Tool "${toolCall.name}" not registered`);
                            result = `Error: Tool "${toolCall.name}" is not registered.`;
                        } else {
                            logger.debug(`[AgentLoop] Executing tool: ${toolCall.name}`, { args: toolCall.args });
                            const raw = await tool.exec(toolCall.args);
                            result = typeof raw === "string" ? raw : JSON.stringify(raw);
                            const elapsed = Date.now() - startTime;
                            logger.info(`[AgentLoop] Tool "${toolCall.name}" completed in ${elapsed}ms`, {
                                resultLen: result.length,
                            });
                        }
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        logger.error(`[AgentLoop] Tool "${toolCall.name}" threw: ${errMsg}`, {
                            stack: err instanceof Error ? err.stack : undefined,
                        });
                        result = `Error: ${errMsg}`;
                    }

                    // Store tool result
                    this.harness.messageManager.add({
                        sessionId,
                        role: "tool",
                        content: result,
                        toolCallId: toolCall.id,
                        createdAt: new Date(),
                        messageId: randomUUID(),
                    });
                    logger.debug(`[AgentLoop] Tool result stored for ${toolCall.name} (id=${toolCall.id})`);
                }
            }
        }

        // Max iterations reached without a final answer
        logger.error(`[AgentLoop] Reached max iterations (${this.maxIterations}) without resolution`);
        throw new Error("Reached maximum loop iterations.");
    }
}