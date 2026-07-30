import { randomUUID } from "node:crypto";
import type { AgentHarness } from "./agent-harness";
import type { ConfirmHook, ToolCall } from "./types";
import { logger } from "../logger";

export class AgentLoop {
    constructor(
        private harness: AgentHarness,
        private llm: any,
        private maxIterations: number = 10
    ) { }

    async execute(sessionId: string, userInput: string, confirmHook?: ConfirmHook): Promise<string> {
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

        // Step 1.5: Build memory context ONCE per user turn (not per iteration)
        let memoryContext = "";
        try {
            memoryContext = await this.harness.buildMemoryContext(userInput);
            logger.debug(`[AgentLoop] Memory context built (len=${memoryContext.length})`);
        } catch (err) {
            logger.error(`[AgentLoop] Failed to build memory context: ${err instanceof Error ? err.message : String(err)}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
            // non-fatal — proceed without memory context rather than blocking the whole task
            memoryContext = "";
        }

        for (let iter = 1; iter <= this.maxIterations; iter++) {
            logger.info(`[AgentLoop] Iteration ${iter}/${this.maxIterations}`);

            // Step 2: Build context
            let context;
            try {
                context = await this.harness.contextBuilder.build(sessionId, memoryContext);
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

                // Fire memory extraction in the background — do not block the response
                this.saveMemoryAsync(sessionId);

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
                    let result = "";
                    const startTime = Date.now();

                    try {
                        const tool = this.harness.toolRegistry.get(toolCall.name);

                        if (!tool) {
                            logger.warn(`[AgentLoop] Tool "${toolCall.name}" not registered`);
                            result = `Error: Tool "${toolCall.name}" is not registered.`;
                        } else {
                            // ── Human-in-the-loop: pause before destructive tools ──
                            let shouldSkip = false;
                            if (tool.destructive && confirmHook) {
                                const summary = JSON.stringify(toolCall.args).slice(0, 200);
                                const msg = `Destructive action: ${toolCall.name}(${summary})`;
                                logger.info(`[AgentLoop] ⏸ Pausing for user confirmation on ${toolCall.name}`, {
                                    args: toolCall.args,
                                });
                                const confirmed = await confirmHook(msg, toolCall.name, toolCall.args);
                                if (!confirmed) {
                                    logger.info(`[AgentLoop] ✋ User rejected ${toolCall.name}`);
                                    result = `User rejected the ${toolCall.name} operation. Inform them and do not retry unless asked.`;
                                    const elapsed = Date.now() - startTime;
                                    logger.info(`[AgentLoop] Tool "${toolCall.name}" skipped (user rejected) in ${elapsed}ms`);
                                    shouldSkip = true;
                                } else {
                                    logger.info(`[AgentLoop] ✅ User confirmed ${toolCall.name} — proceeding`);
                                }
                            }

                            if (!shouldSkip) {
                                logger.debug(`[AgentLoop] Executing tool: ${toolCall.name}`, { args: toolCall.args });
                                const raw = await tool.exec(toolCall.args);
                                result = typeof raw === "string" ? raw : JSON.stringify(raw);
                                const elapsed = Date.now() - startTime;
                                logger.info(`[AgentLoop] Tool "${toolCall.name}" completed in ${elapsed}ms`, {
                                    resultLen: result.length,
                                });
                            }
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

        // Still worth extracting — e.g. to learn a "gets stuck on X" procedural pattern
        this.saveMemoryAsync(sessionId);

        throw new Error("Reached maximum loop iterations.");
    }

    // --- Fire-and-forget memory extraction; failures are logged, never thrown ---
    private saveMemoryAsync(sessionId: string): void {
        let trace: string;
        try {
            trace = this.serializeTrace(this.harness.messageManager.get(sessionId));
        } catch (err) {
            logger.error(`[AgentLoop] Failed to serialize trace for memory extraction: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }

        this.harness.onTaskComplete(trace).catch((err) => {
            logger.error(`[AgentLoop] Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
        });
    }

    // --- Converts stored messages into a compact, LLM-readable execution trace ---
    private serializeTrace(messages: any[]): string {
        return messages
            .map((m) => {
                if (m.role === "tool") {
                    return `[tool result] ${String(m.content).slice(0, 500)}`;
                }
                if (m.toolCalls?.length) {
                    return `[assistant requested tools] ${m.toolCalls.map((t: any) => t.name).join(", ")}`;
                }
                return `[${m.role}] ${m.content}`;
            })
            .join("\n");
    }
}