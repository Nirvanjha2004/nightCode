import { randomUUID } from "node:crypto";
import type { AgentHarness } from "./agent-harness";
import { CancelledError } from "./types";
import type { AgentEvent, ConfirmHook, ToolCall } from "./types";
import { resolveSlashCommand } from "./commands";
import type { ChatLLM } from "../llm-client/types";
import { logger } from "../logger";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { markSpanError, tracer } from "../telemetry";

/**
 * Throw a CancelledError when the run's AbortSignal has fired. Checked at
 * every loop boundary (start, iteration top, after the LLM call, before each
 * tool) so an aborted run stops between steps instead of running more tools.
 */
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new CancelledError();
    }
}

/**
 * Per-call options for AgentLoop.execute. All fields optional — a normal
 * user message passes no options and behaves exactly as before.
 */
export interface ExecuteOptions {
    /** HITL confirmation hook (destructive tool guard), same as the old bare third param. */
    confirmHook?: ConfirmHook;
    /** Marks this execution as a subagent run (span attribute only). */
    isSubagent?: boolean;
    /** Skip the background memory-extraction pass — used by subagents (no duplicate memory writes). */
    skipMemoryExtraction?: boolean;
    /** Pre-built memory context; skips the (embedding-costly) buildMemoryContext call entirely. */
    overrideMemoryContext?: string;
    /** Tool scope for this turn; overrides any slash-command allowed-tools. */
    allowedTools?: string[];
    /** UI event stream — emitted as the run progresses (stages, iterations, tool calls). */
    onEvent?: (event: AgentEvent) => void;
    /** Cancellation signal — Esc / first Ctrl+C aborts the run; the loop stops between steps. */
    signal?: AbortSignal;
}

// Tool-call args are trimmed when stored in history so one giant `write`/`bash`
// arg can't bloat the context window. IDs are preserved — only the string args
// are shortened — so the stored assistant intent still links to its tool results.
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

// UI previews for the activity feed — keep what reaches the renderer tiny:
// short JSON head for args, a few lines for results (a multi-MB bash log must
// never round-trip through React state).
const PREVIEW_ARGS_MAX = 100;
const PREVIEW_RESULT_MAX = 400;
const PREVIEW_RESULT_LINES = 5;

export function previewToolArgs(toolName: string, args: Record<string, unknown>): string {
    // bash: the command itself is the signal — show it, not its JSON wrapper.
    if (toolName === "bash" && typeof args.command === "string") {
        const cmd = args.command;
        return cmd.length > PREVIEW_ARGS_MAX ? cmd.slice(0, PREVIEW_ARGS_MAX) + "…" : cmd;
    }
    const s = JSON.stringify(args);
    return s.length > PREVIEW_ARGS_MAX ? s.slice(0, PREVIEW_ARGS_MAX) + "…" : s;
}

export function previewToolResult(result: string): string {
    // Only the head is ever shown — bound the scan so a multi-MB bash log is
    // never fully copied or split into a line array on the loop's hot path.
    const truncated = result.length > PREVIEW_RESULT_MAX + 5000;
    const head = result.slice(0, PREVIEW_RESULT_MAX + 5000).replace(/\r\n/g, "\n");
    const lines = head.split("\n");
    let out = lines.slice(0, PREVIEW_RESULT_LINES).join("\n");
    // Cap the content BEFORE the marker so the truncation note always survives.
    if (out.length > PREVIEW_RESULT_MAX) out = out.slice(0, PREVIEW_RESULT_MAX) + "…";
    if (truncated) {
        out += "\n… (output truncated)";
    } else if (lines.length > PREVIEW_RESULT_LINES) {
        out += `\n… (${lines.length - PREVIEW_RESULT_LINES} more lines)`;
    }
    return out;
}

// Concise, bounded failure summary for the activity feed when a tool FAILS.
// The full result is still stored in history for the agent — this is purely
// the UI one-liner, so a 10k-line failed build never dumps into the terminal.
// Shell-formatted results (bash) end with `exit code: N — took Xms`: surface
// the exit code plus the first meaningful stderr line (where failures usually
// surface). Thrown errors: keep the message, drop the `Error: ` prefix.
const FAILURE_SUMMARY_LINES = 2;
const FAILURE_SUMMARY_LINE_MAX = 120;

export function summarizeToolFailure(result: string): string {
    const lines = result.replace(/\r\n/g, "\n").split("\n");
    // formatShellResult always ends with `exit code: N … — took Xms` — match
    // only the LAST line so an "exit code: N" printed in stdout/stderr can't
    // be mistaken for the real exit code.
    const exitMatch = lines[lines.length - 1]?.match(/exit code: (\d+)/);
    if (exitMatch) {
        const summary = [`exit code ${exitMatch[1]}`];
        const stderrIdx = lines.findIndex((l) => l === "--- stderr ---");
        if (stderrIdx >= 0) {
            for (const raw of lines.slice(stderrIdx + 1)) {
                const line = raw.trim();
                if (line && !line.startsWith("exit code:")) {
                    summary.push(line.slice(0, FAILURE_SUMMARY_LINE_MAX));
                    break;
                }
            }
        }
        return summary.slice(0, FAILURE_SUMMARY_LINES).join("\n");
    }
    const first = lines.find((l) => l.trim()) ?? "Tool failed";
    return first.replace(/^Error:\s*/, "").slice(0, FAILURE_SUMMARY_LINE_MAX);
}

export class AgentLoop {
    constructor(
        private harness: AgentHarness,
        private llm: ChatLLM,
        private maxIterations: number = 10
    ) { }

    async execute(sessionId: string, userInput: string, options?: ExecuteOptions): Promise<string> {
        return tracer.startActiveSpan("agent.execute", async (span) => {
            try {
                span.setAttribute("session.id", sessionId);
                span.setAttribute("model.name", this.harness.sessionManager.get(sessionId)?.model ?? "unknown");
                span.setAttribute("user.input.length", userInput.length);
                span.setAttribute("max_iterations", this.maxIterations);
                span.setAttribute("is_subagent", options?.isSubagent ?? false);
                span.addEvent("Agent execution started");

                logger.info(`[AgentLoop] Starting execution — session=${sessionId}`, {
                    userInput: userInput.slice(0, 200),
                });

                // A run that was already cancelled before starting must not touch history.
                throwIfAborted(options?.signal);

                // Step 0: Resolve slash commands — pure input transformation + optional
                // tool scope. No new execution path: the resolved prompt flows through the
                // existing AgentLoop. The ORIGINAL raw input is stored in message history;
                // the model receives the resolved prompt via context substitution below.
                // Unknown `/foo` commands pass through unchanged as normal messages.
                const { resolvedInput, activeCommand } = resolveSlashCommand(userInput, this.harness.commandRegistry);

                if (userInput.startsWith("/")) {
                    logger.info(`[CommandRegistry] Slash command resolved`, {
                        "command.name": activeCommand?.name ?? userInput.slice(1).split(" ")[0],
                        "command.found": activeCommand !== undefined,
                        "command.allowed_tools": activeCommand?.allowedTools?.join(",") ?? "",
                    });
                }
                if (activeCommand) {
                    span.setAttribute("command.name", activeCommand.name);
                    span.setAttribute("command.found", true);
                    span.setAttribute("command.allowed_tools", activeCommand.allowedTools?.join(",") ?? "");
                }

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
                // Subagents skip the lookup entirely — the caller injects a static memory
                // snapshot (overrideMemoryContext) instead, so no episodic embedding call.
                let memoryContext = "";
                if (options?.overrideMemoryContext !== undefined) {
                    memoryContext = options.overrideMemoryContext;
                    logger.debug(`[AgentLoop] Memory context overridden (len=${memoryContext.length})`);
                } else {
                    try {
                        options?.onEvent?.({ type: "stage", name: "memory" });
                        memoryContext = await this.harness.buildMemoryContext(resolvedInput);
                        logger.debug(`[AgentLoop] Memory context built (len=${memoryContext.length})`);
                    } catch (err) {
                        logger.error(`[AgentLoop] Failed to build memory context: ${err instanceof Error ? err.message : String(err)}`, {
                            stack: err instanceof Error ? err.stack : undefined,
                        });
                        memoryContext = "";
                    }
                }

                for (let iter = 1; iter <= this.maxIterations; iter++) {
                    throwIfAborted(options?.signal);
                    logger.info(`[AgentLoop] Iteration ${iter}/${this.maxIterations}`);
                    options?.onEvent?.({ type: "iteration", n: iter, max: this.maxIterations });

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
                                            // The tool scope stays in effect for EVERY context rebuild of this
                                            // turn, across all ReAct iterations. Subagent restrictions (options)
                                            // take precedence over the active slash command's allowed-tools.
                                            // resolvedInput is substituted for the last user message inside
                                            // the context builder, so the model sees the expanded prompt.
                                            const effectiveAllowedTools =
                                                options?.allowedTools ?? activeCommand?.allowedTools;
                                            const built = await this.harness.contextBuilder.build(
                                                sessionId,
                                                memoryContext,
                                                effectiveAllowedTools,
                                                resolvedInput
                                            );
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
                                const response = await this.llm.chat(context, options?.signal);
                                throwIfAborted(options?.signal);

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
                                    // Subagents skip extraction entirely (no duplicate memory writes).
                                    if (!options?.skipMemoryExtraction) {
                                        this.saveMemoryAsync(sessionId, span, options);
                                    }

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

                                    // Assistant intent — toolCalls is the plural array field.
                                    // Stored ONCE, with trimmed args, right before the tools run;
                                    // each tool's RESULT is then appended below as a role:"tool"
                                    // message (linked by toolCallId) so the model can see it.
                                    this.harness.messageManager.add({
                                        sessionId,
                                        role: "assistant",
                                        content: "",
                                        toolCalls: trimToolCallArgsForHistory(toolCalls),
                                        createdAt: new Date(),
                                        messageId: randomUUID(),
                                    });
                                    logger.debug(`[AgentLoop] Assistant tool-call message stored`);

                                    // Execute each tool call
                                    iterSpan.addEvent("Tool execution started");
                                    let toolCallIndex = 0;
                                    for (const toolCall of toolCalls) {
                                        // Stop before running any NEW tool after cancellation — but keep
                                        // history valid: every id in the stored assistant intent still gets
                                        // a role:"tool" response, so the next prompt isn't rejected for
                                        // orphaned tool_calls.
                                        if (options?.signal?.aborted) {
                                            this.storeCancelledToolResults(sessionId, toolCalls.slice(toolCallIndex));
                                            throwIfAborted(options?.signal);
                                        }
                                        let result = "";
                                        let toolOk = true;
                                        // File tools attach a display-only change summary (diff stats + bounded
                                        // -/+ lines) that becomes the feed preview instead of the raw result head.
                                        let changeSummary: string | undefined;
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
                                                        toolOk = false;
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

                                                    if (isDestructiveCall && options?.confirmHook) {
                                                        const summary = JSON.stringify(toolCall.args).slice(0, 200);
                                                        const msg = `Destructive action: ${toolCall.name}(${summary})`;
                                                        logger.info(`[AgentLoop] ⏸ Pausing for user confirmation on ${toolCall.name}`, {
                                                            args: toolCall.args,
                                                        });
                                                        const confirmed = await options.confirmHook(msg, toolCall.name, toolCall.args);
                                                        if (!confirmed) {
                                                            logger.info(`[AgentLoop] ✋ User rejected ${toolCall.name}`);
                                                            result = `User rejected the ${toolCall.name} operation. Inform them and do not retry unless asked.`;
                                                            toolOk = false;
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
                                                    // Pass the harness so tools (e.g. spawn_subagent) can call back into the loop.
                                                    options?.onEvent?.({
                                                        type: "tool_start",
                                                        toolName: toolCall.name,
                                                        argsPreview: previewToolArgs(toolCall.name, toolCall.args),
                                                    });
                                                    const execResult: unknown = await tool.exec(toolCall.args, this.harness, options?.signal);
                                                    if (typeof execResult === "string") {
                                                        result = execResult;
                                                    } else if (execResult && typeof execResult === "object") {
                                                        // Structured shell-tool result: a failing command is a RESULT, not an
                                                        // exception (the model gets stdout/stderr/exit code and can recover), but
                                                        // `ok: false` flips the feed row to ✗. The full text stays the agent's view.
                                                        // File tools add `changeSummary` — a display-only diff — surfaced in the
                                                        // feed below; the agent still sees `text` unchanged.
                                                        const structured = execResult as { ok?: boolean; text?: string; changeSummary?: string };
                                                        if (structured.ok === false) toolOk = false;
                                                        result = typeof structured.text === "string" ? structured.text : JSON.stringify(execResult);
                                                        if (typeof structured.changeSummary === "string") changeSummary = structured.changeSummary;
                                                    } else {
                                                        result = JSON.stringify(execResult);
                                                    }
                                                    const elapsed = Date.now() - startTime;
                                                    logger.info(`[AgentLoop] Tool "${toolCall.name}" completed in ${elapsed}ms`, {
                                                        resultLen: result.length,
                                                    });
                                                    toolSpan.setAttribute("tool.success", toolOk);
                                                    toolSpan.setAttribute("tool.result.length", result.length);
                                                    toolSpan.addEvent("Tool finished");
                                                } catch (err) {
                                                    // Cancellation is not a tool failure: the in-flight tool's result is
                                                    // still stored (history must keep its assistant-tool_calls → tool
                                                    // pairing, or the next prompt would fail), then the next loop
                                                    // boundary throws CancelledError and stops the run.
                                                    const aborted = options?.signal?.aborted === true;
                                                    const errMsg = err instanceof Error ? err.message : String(err);
                                                    if (aborted) {
                                                        logger.info(`[AgentLoop] Tool "${toolCall.name}" cancelled by user`);
                                                        result = "⚠ Tool execution cancelled — the agent run was interrupted.";
                                                    } else {
                                                        logger.error(`[AgentLoop] Tool "${toolCall.name}" threw: ${errMsg}`, {
                                                            stack: err instanceof Error ? err.stack : undefined,
                                                        });
                                                        result = `Error: ${errMsg}`;
                                                    }
                                                    toolOk = false;
                                                    markSpanError(toolSpan, aborted ? new CancelledError() : err);
                                                    toolSpan.addEvent(aborted ? "Tool cancelled by user" : "Tool threw exception");
                                                    toolSpan.setAttribute("tool.success", false);
                                                    toolSpan.setAttribute("tool.result.length", result.length);
                                                } finally {
                                                    toolSpan.setAttribute("tool.duration_ms", Date.now() - startTime);
                                                    toolSpan.end();
                                                }
                                            }
                                        );

                                        options?.onEvent?.({
                                            type: "tool_end",
                                            toolName: toolCall.name,
                                            ok: toolOk,
                                            durationMs: Date.now() - startTime,
                                            // Success: the file tools' change summary (bounded diff) when present,
                                            // else the bounded head preview. Failure: concise one-liner — the full
                                            // result (exit code, stderr, stdout) still reaches the agent.
                                            resultPreview: toolOk
                                                ? changeSummary ?? previewToolResult(result)
                                                : summarizeToolFailure(result),
                                        });

                                        // Store the tool RESULT back into history (role:"tool", linked
                                        // to the assistant intent via toolCallId). This is what the model
                                        // actually sees on the next iteration — without it, Groq rejects
                                        // the orphaned tool_calls message and the agent never learns
                                        // what any tool returned.
                                        this.harness.messageManager.add({
                                            sessionId,
                                            role: "tool",
                                            content: result,
                                            toolCallId: toolCall.id,
                                            createdAt: new Date(),
                                            messageId: randomUUID(),
                                        });
                                        logger.debug(`[AgentLoop] Tool result stored for ${toolCall.name} (id=${toolCall.id})`);
                                        toolCallIndex++;
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
                throwIfAborted(options?.signal);
                logger.error(`[AgentLoop] Reached max iterations (${this.maxIterations}) without resolution`);
                span.addEvent("Maximum iterations reached");

                // Still worth extracting — e.g. to learn a "gets stuck on X" procedural pattern
                if (!options?.skipMemoryExtraction) {
                    this.saveMemoryAsync(sessionId, span, options);
                }

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

    // When a run is cancelled mid-batch, every tool_call id in the already-stored
    // assistant intent must still receive a role:"tool" response — otherwise the
    // next prompt would be rejected for orphaned tool_calls. Synthetic cancelled
    // results fill in for calls that never ran.
    private storeCancelledToolResults(sessionId: string, toolCalls: ToolCall[]): void {
        for (const tc of toolCalls) {
            this.harness.messageManager.add({
                sessionId,
                role: "tool",
                content: "⚠ Tool execution cancelled — the agent run was interrupted.",
                toolCallId: tc.id,
                createdAt: new Date(),
                messageId: randomUUID(),
            });
        }
    }

    // --- Fire-and-forget memory extraction; failures are logged, never thrown ---
    // Note: extraction is deliberately not awaited (it must not block the response), so
    // the agent.execute span usually ends before the promise resolves and the
    // "Memory extraction finished" event below lands only if the span is still recording.
    private saveMemoryAsync(sessionId: string, span: Span, options?: ExecuteOptions): void {
        options?.onEvent?.({ type: "stage", name: "extract" });
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
