import { randomUUID } from "node:crypto";
import type { AgentHarness } from "./agent-harness";
import type { ConfirmHook, ToolCall } from "./types";
import { logger } from "../logger";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { markSpanError, tracer } from "../telemetry";

export class AgentLoop {
    constructor(
        private harness: AgentHarness,
        private llm: any,
        private maxIterations: number = 10
    ) { }

    async execute(sessionId: string, userInput: string, confirmHook?: ConfirmHook): Promise<string> {
        return tracer.startActiveSpan("agent.execute", async (span) => {
            try {
                span.setAttribute("session.id", sessionId);
                span.setAttribute("model.name", this.harness.sessionManager.get(sessionId)?.model ?? "unknown");
                span.setAttribute("user.input.length", userInput.length);
                span.setAttribute("max_iterations", this.maxIterations);
                span.addEvent("Agent execution started");

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
                    memoryContext = "";
                }

                for (let iter = 1; iter <= this.maxIterations; iter++) {
                    logger.info(`[AgentLoop] Iteration ${iter}/${this.maxIterations}`);

                    const iteration = await tracer.startActiveSpan(
                        `iteration_${iter}`,
                        async (iterSpan): Promise<{ done: boolean; content: string }> => {
                            try {
                                iterSpan.setAttribute("iteration.number", iter);
                                iterSpan.addEvent("Iteration started");

                                // Step 2: Build context
                                const context = await tracer.startActiveSpan(
                                    "context.build",
                                    async (ctxSpan) => {
                                        try {
                                            ctxSpan.addEvent("Building context");
                                            const built = await this.harness.contextBuilder.build(sessionId, memoryContext);
                                            ctxSpan.setAttribute("context.messages", built.messages.length);
                                            ctxSpan.setAttribute("context.tools", built.tools.length);
                                            ctxSpan.setAttribute("context.system_prompt.length", built.systemPrompt.length);
                                            ctxSpan.setAttribute("context.memory.length", memoryContext.length);
                                            ctxSpan.setAttribute(
                                                "context.total.characters",
                                                built.systemPrompt.length +
                                                built.messages.reduce((sum, m) => sum + m.content.length, 0) +
                                                JSON.stringify(built.tools).length
                                            );
                                            ctxSpan.addEvent("Context ready");
                                            logger.debug(`[AgentLoop] Context built — ${built.messages.length} messages, ${built.tools.length} tools`);
                                            return built;
                                        } catch (err) {
                                            logger.error(`[AgentLoop] Failed to build context: ${err instanceof Error ? err.message : String(err)}`, {
                                                stack: err instanceof Error ? err.stack : undefined,
                                            });
                                            markSpanError(ctxSpan, err);
                                            throw err;
                                        } finally {
                                            ctxSpan.end();
                                        }
                                    }
                                );

                                iterSpan.addEvent("Context built");
                                iterSpan.setAttribute("context.message.count", context.messages.length);
                                iterSpan.setAttribute("context.tool.count", context.tools.length);

                                // Step 3: LLM call — traced as "llm.call" inside the client
                                const response = await this.llm.chat(context);

                                iterSpan.addEvent("LLM response received");
                                iterSpan.setAttribute("llm.response.type", response.type);
                                iterSpan.setAttribute("tool.calls.count", response.type === "tool_calls" ? response.toolCalls.length : 0);
                                logger.debug(`[AgentLoop] LLM response type: ${response.type}`);

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
                                    this.saveMemoryAsync(sessionId, span);

                                    iterSpan.addEvent("Iteration completed");
                                    return { done: true, content: response.content };
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
                                    iterSpan.addEvent("Tool execution started");
                                    for (const toolCall of toolCalls) {
                                        let result = "";
                                        const startTime = Date.now();

                                        await tracer.startActiveSpan(
                                            `tool.${toolCall.name}`,
                                            async (toolSpan) => {
                                                try {
                                                    toolSpan.setAttribute("tool.name", toolCall.name);
                                                    toolSpan.setAttribute("tool.id", toolCall.id);
                                                    toolSpan.addEvent("Executing tool");

                                                    const tool = this.harness.toolRegistry.get(toolCall.name);

                                                    if (!tool) {
                                                        logger.warn(`[AgentLoop] Tool "${toolCall.name}" not registered`);
                                                        result = `Error: Tool "${toolCall.name}" is not registered.`;
                                                        toolSpan.setAttribute("tool.success", false);
                                                        toolSpan.setAttribute("tool.result.length", result.length);
                                                        toolSpan.setStatus({
                                                            code: SpanStatusCode.ERROR,
                                                            message: `Tool "${toolCall.name}" is not registered.`,
                                                        });
                                                        return;
                                                    }

                                                    // ── Human-in-the-loop: pause before destructive tools ──
                                                    // Static flag (write/delete/...) OR dynamic check on the actual args
                                                    // (bash command containing `rm -rf`, `git reset --hard`, ...).
                                                    const isDestructiveCall =
                                                        tool.destructive === true ||
                                                        (typeof tool.isDestructive === "function" &&
                                                            tool.isDestructive(toolCall.args));
                                                    toolSpan.setAttribute("tool.destructive", isDestructiveCall);

                                                    if (isDestructiveCall && confirmHook) {
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
                                                            toolSpan.addEvent("Tool rejected by user");
                                                            toolSpan.setAttribute("tool.success", false);
                                                            toolSpan.setAttribute("tool.result.length", result.length);
                                                            return;
                                                        }
                                                        logger.info(`[AgentLoop] ✅ User confirmed ${toolCall.name} — proceeding`);
                                                    }

                                                    logger.debug(`[AgentLoop] Executing tool: ${toolCall.name}`, { args: toolCall.args });
                                                    const execResult = await tool.exec(toolCall.args);
                                                    result = typeof execResult === "string" ? execResult : JSON.stringify(execResult);
                                                    const elapsed = Date.now() - startTime;
                                                    logger.info(`[AgentLoop] Tool "${toolCall.name}" completed in ${elapsed}ms`, {
                                                        resultLen: result.length,
                                                    });
                                                    toolSpan.setAttribute("tool.success", true);
                                                    toolSpan.setAttribute("tool.result.length", result.length);
                                                    toolSpan.addEvent("Tool finished");
                                                } catch (err) {
                                                    const errMsg = err instanceof Error ? err.message : String(err);
                                                    logger.error(`[AgentLoop] Tool "${toolCall.name}" threw: ${errMsg}`, {
                                                        stack: err instanceof Error ? err.stack : undefined,
                                                    });
                                                    result = `Error: ${errMsg}`;
                                                    markSpanError(toolSpan, err);
                                                    toolSpan.addEvent("Tool threw exception");
                                                    toolSpan.setAttribute("tool.success", false);
                                                    toolSpan.setAttribute("tool.result.length", result.length);
                                                } finally {
                                                    toolSpan.setAttribute("tool.duration_ms", Date.now() - startTime);
                                                    toolSpan.end();
                                                }
                                            }
                                        );

                                        // AgentLoop.ts me, assistant tool-call message store karte waqt
                                        function trimToolCallArgsForHistory(toolCalls: ToolCall[]): ToolCall[] {
                                            return toolCalls.map((tc) => {
                                                const trimmedArgs = { ...tc.args };
                                                for (const key of Object.keys(trimmedArgs)) {
                                                    const val = trimmedArgs[key];
                                                    if (typeof val === "string" && val.length > 300) {
                                                        trimmedArgs[key] = val.slice(0, 300) + `... [truncated, ${val.length - 300} more chars — full content was already written to disk]`;
                                                    }
                                                }
                                                return { ...tc, args: trimmedArgs };
                                            });
                                        }

                                        this.harness.messageManager.add({
                                            sessionId,
                                            role: "assistant",
                                            content: "",
                                            toolCalls: trimToolCallArgsForHistory(toolCalls), // ✅ ab history me sirf 300 chars jaayenge, poora 4000 nahi
                                            createdAt: new Date(),
                                            messageId: randomUUID(),
                                        });
                                        logger.debug(`[AgentLoop] Tool result stored for ${toolCall.name} (id=${toolCall.id})`);
                                    }
                                    iterSpan.addEvent("Tool execution finished");
                                }

                                iterSpan.addEvent("Iteration completed");
                                return { done: false, content: "" };
                            } catch (err) {
                                markSpanError(iterSpan, err);
                                throw err;
                            } finally {
                                iterSpan.end();
                            }
                        }
                    );

                    if (iteration.done) {
                        span.addEvent("Final response returned");
                        return iteration.content;
                    }
                }

                // Max iterations reached without a final answer
                logger.error(`[AgentLoop] Reached max iterations (${this.maxIterations}) without resolution`);
                span.addEvent("Maximum iterations reached");

                // Still worth extracting — e.g. to learn a "gets stuck on X" procedural pattern
                this.saveMemoryAsync(sessionId, span);

                throw new Error("Reached maximum loop iterations.");
            } catch (err) {
                markSpanError(span, err);
                throw err;
            } finally {
                span.addEvent("Agent execution finished");
                span.end();
            }
        });
    }

    // --- Fire-and-forget memory extraction; failures are logged, never thrown ---
    // Note: extraction is deliberately not awaited (it must not block the response), so
    // the agent.execute span usually ends before the promise resolves and the
    // "Memory extraction finished" event below lands only if the span is still recording.
    private saveMemoryAsync(sessionId: string, span: Span): void {
        span.addEvent("Memory extraction started");
        let trace: string;
        try {
            trace = this.serializeTrace(this.harness.messageManager.get(sessionId));
        } catch (err) {
            logger.error(`[AgentLoop] Failed to serialize trace for memory extraction: ${err instanceof Error ? err.message : String(err)}`);
            if (span.isRecording()) {
                span.addEvent("Memory extraction finished");
            }
            return;
        }

        this.harness.onTaskComplete(trace)
            .then(() => {
                // The agent.execute span may already be closed by the time the
                // fire-and-forget extraction finishes — only record if still recording.
                if (span.isRecording()) {
                    span.addEvent("Memory extraction finished");
                }
            })
            .catch((err) => {
                logger.error(`[AgentLoop] Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`, {
                    stack: err instanceof Error ? err.stack : undefined,
                });
                if (span.isRecording()) {
                    span.addEvent("Memory extraction finished");
                }
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
