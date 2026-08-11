import Groq from "groq-sdk";

import type { LLMClient } from "./client";
import { CancelledError } from "../agent/types";
import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

import { logger } from "../logger";
import { markSpanError, tracer } from "../telemetry";

const LLM_TEMPERATURE = 0.1;

// Groq's SDK wraps the API error body: `err.error` is the WHOLE response body
// `{ error: { code, message, ... } }`, so the code lives at `err.error.error.code`.
// The flat fallbacks cover other SDK shapes/versions; returning undefined means
// "unrecognized error" — the caller logs it and rethrows.
export function getGroqErrorCode(err: unknown): string | undefined {
    const e = err as { error?: { error?: { code?: string }; code?: string }; code?: string };
    return e?.error?.error?.code ?? e?.error?.code ?? e?.code;
}

// The model occasionally emits tool calls in a wrong format (e.g. XML
// `<function=...>` instead of Groq's native JSON). Groq rejects the request
// with `tool_use_failed` and includes the rejected generation — we replay it
// back to the model so it can see exactly what it did wrong and correct it.
const REPAIR_PROMPT = `

IMPORTANT:
Use ONLY the native tool calling interface.
Never emit XML tags such as <function>.
Never emit JSON describing a tool call.
If a tool is needed, use the provided tool interface.
Otherwise answer normally.`;

export class GroqClient implements LLMClient {
    private client: Groq;

    constructor(apiKey: string) {
        this.client = new Groq({ apiKey });
        logger.info("[GroqClient] Initialized");
    }

    async chat(
        context: ContextType,
        signal?: AbortSignal,
        onDelta?: (text: string) => void
    ): Promise<LLMResponse> {
        logger.info(
            `[GroqClient] Chat request | model=${context.model} | messages=${context.messages.length} | tools=${context.tools.length}`
        );

        try {
            return await this.callGroq(context, "auto", signal, onDelta);
        } catch (err: any) {
            // Cancellation via AbortSignal is NOT an API failure — surface it
            // untouched (no retry, no repair prompt, no error log).
            if (signal?.aborted) {
                // If the SDK aborted the underlying fetch, this fires within ms;
                // a large elapsed here means the abort never reached the request.
                throw err;
            }

            const code = getGroqErrorCode(err);

            logger.error(
                `[GroqClient] Request failed (${code ?? "unknown"}) : ${
                    err?.message ?? err
                }`
            );

            if (code === "tool_use_failed") {
                logger.warn(
                    "[GroqClient] Retrying once with tool-calling repair prompt"
                );

                try {
                    const failedGeneration =
                        (err?.error?.error as { failed_generation?: string } | undefined)
                            ?.failed_generation ?? "";
                    const feedback = failedGeneration
                        ? `\n\nYour previous response was rejected because it used an invalid tool-call format. You wrote:\n${failedGeneration.slice(0, 1500)}`
                        : "";

                    return await this.callGroq(
                        {
                            ...context,
                            systemPrompt: context.systemPrompt + REPAIR_PROMPT + feedback,
                        },
                        "auto",
                        signal,
                        onDelta
                    );
                } catch (repairErr: any) {
                    if (signal?.aborted) {
                        throw repairErr;
                    }

                    const repairCode = getGroqErrorCode(repairErr);

                    if (repairCode === "tool_use_failed") {
                        // Final fallback: retry WITHOUT tools so the model is forced
                        // to answer in plain text rather than crash the whole turn.
                        logger.warn(
                            "[GroqClient] Repair retry also produced invalid tool calls — retrying once without tools (text-only)"
                        );
                        return await this.callGroq(
                            {
                                ...context,
                                tools: [],
                                systemPrompt:
                                    context.systemPrompt +
                                    `\n\nIMPORTANT:\nTool calling is currently unavailable. Answer the user's request directly in plain text based on the conversation so far.`,
                            },
                            "none", // explicit: no tool calls allowed, plain text only
                            signal,
                            onDelta
                        );
                    }

                    throw repairErr;
                }
            }

            throw err;
        }
    }

    private async callGroq(
        context: ContextType,
        toolChoice: "auto" | "none" = "auto",
        signal?: AbortSignal,
        onDelta?: (text: string) => void
    ): Promise<LLMResponse> {
        return tracer.startActiveSpan("llm.call", async (llmSpan): Promise<LLMResponse> => {
            // Cancel-latency bisect: (1) prove the abort EVENT is delivered to the
            // request options (the SDK's own listener fires on the same dispatch),
            // and (2) separate fetch-rejection time from post-rejection time. A gap
            // between "SDK abort event delivered" and "fetch rejected" means the
            // fetch itself held the abort; a gap after "fetch rejected" means
            // span.end()/markSpanError/logging blocked.
            const onAbortEvent = () => {
                console.log("SDK abort event delivered to request options", signal);
            };
            if (signal) {
                if (signal.aborted) onAbortEvent();
                else signal.addEventListener("abort", onAbortEvent, { once: true });
            }

            try {
                const started = Date.now();

                llmSpan.setAttribute("llm.provider", "groq");
                llmSpan.setAttribute("llm.model", context.model);
                llmSpan.setAttribute("llm.temperature", LLM_TEMPERATURE);
                // llm.max_tokens is intentionally omitted: the request never sends
                // max_tokens, so there is no value to attribute.
                llmSpan.addEvent("Sending request to LLM");

                // ── Abort watchdog ──────────────────────────────────────────────
                // Bun's fetch does not reliably reject an in-flight request when its
                // AbortSignal fires — measured 7+ seconds of the fetch holding the
                // abort while the run's signal fired in 2ms. The SDK cannot fix that,
                // so race the request AND each streamed chunk read against a watchdog
                // that rejects the INSTANT the run's signal fires. Cancellation then
                // settles in ~ms regardless of the fetch's behavior; the orphaned
                // request settles in the background and is swallowed below.
                // ponytail: the orphaned request stays alive until the SDK's 60s
                // timeout, holding one socket in the background — bounded and
                // user-invisible; the upgrade path is a hard kill, which the SDK
                // already partially does by relaying the same signal to the fetch.
                let onAbort: (() => void) | undefined;
                const abortPromise = new Promise<never>((_resolve, reject) => {
                    onAbort = () => {
                        reject(new CancelledError());
                    };
                    if (signal?.aborted) onAbort();
                    else signal?.addEventListener("abort", onAbort, { once: true });
                });

                // stream: true — the assistant's text arrives chunk by chunk.
                const createPromise = this.client.chat.completions.create({
                    model: context.model,

                    tools: context.tools,

                    tool_choice: toolChoice,

                    temperature: LLM_TEMPERATURE,

                    stream: true,

                    messages: [
                        {
                            role: "system",
                            content: context.systemPrompt,
                        },

                        ...context.messages.map((message) => {
                            if (message.role === "tool") {
                                if (!message.toolCallId) {
                                    throw new Error(
                                        `Tool message ${message.messageId} is missing toolCallId`
                                    );
                                }

                                return {
                                    role: "tool" as const,
                                    tool_call_id: message.toolCallId,
                                    content: message.content,
                                };
                            }

                            if (
                                message.role === "assistant" &&
                                message.toolCalls?.length
                            ) {
                                return {
                                    role: "assistant" as const,

                                    content:
                                        message.content || null,

                                    tool_calls:
                                        message.toolCalls.map((toolCall) => ({
                                            id: toolCall.id,

                                            type: "function" as const,

                                            function: {
                                                name: toolCall.name,

                                                arguments: JSON.stringify(
                                                    toolCall.args
                                                ),
                                            },
                                        })),
                                };
                            }

                            return {
                                role: message.role as
                                    | "user"
                                    | "assistant",

                                content: message.content,
                            };
                        }),
                    ],
                }, { signal });
                createPromise.catch(() => {}); // never surface the orphaned settle

                try {
                    const stream = await Promise.race([createPromise, abortPromise]);

                    const iterator = stream[Symbol.asyncIterator]();
                    let fullContent = "";
                    const toolCallFragments: Array<{ id: string; name: string; arguments: string }> = [];

                    while (true) {
                        // Race each chunk read against the watchdog so an abort
                        // mid-response settles in ~ms, not after the stream stalls.
                        const { done, value } = await Promise.race([iterator.next(), abortPromise]);
                        if (done) break;

                        const delta = value.choices?.[0]?.delta;

                        if (delta?.content) {
                            fullContent += delta.content;
                            onDelta?.(delta.content);
                        }

                        // Tool-call fragments arrive split across chunks; the SDK
                        // keys them by index, so reassemble them positionally.
                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                toolCallFragments[idx] = toolCallFragments[idx] ?? { id: "", name: "", arguments: "" };
                                if (tc.id) toolCallFragments[idx].id = tc.id;
                                if (tc.function?.name) toolCallFragments[idx].name = tc.function.name;
                                if (tc.function?.arguments) toolCallFragments[idx].arguments += tc.function.arguments;
                            }
                        }

                        // Groq sends token usage in the final streamed chunk.
                        if (value.x_groq?.usage) {
                            llmSpan.setAttribute("llm.input_tokens", value.x_groq.usage.prompt_tokens);
                            llmSpan.setAttribute("llm.output_tokens", value.x_groq.usage.completion_tokens);
                            llmSpan.setAttribute("llm.total_tokens", value.x_groq.usage.total_tokens);
                        }
                    }

                    const elapsed = Date.now() - started;

                    if (toolCallFragments.length > 0) {
                        logger.info(
                            `[GroqClient] ${toolCallFragments.length} tool call(s) generated (${elapsed} ms)`
                        );

                        llmSpan.setAttribute("llm.response.type", "tool_calls");
                        llmSpan.setAttribute("llm.tool_calls", toolCallFragments.length);
                        llmSpan.setAttribute("llm.response.length", toolCallFragments.length);
                        llmSpan.addEvent("Tool calls requested");

                        return {
                            type: "tool_calls",

                            toolCalls: toolCallFragments.map((toolCall) => {
                                if (!toolCall.id) {
                                    throw new Error(
                                        "Tool call missing id"
                                    );
                                }

                                if (!toolCall.name) {
                                    throw new Error(
                                        "Tool call missing function name"
                                    );
                                }

                                let args: Record<string, unknown>;

                                try {
                                    args = JSON.parse(
                                        toolCall.arguments
                                    );
                                } catch {
                                    throw new Error(
                                        `Failed to parse tool arguments for "${toolCall.name}"`
                                    );
                                }

                                return {
                                    id: toolCall.id,
                                    name: toolCall.name,
                                    args,
                                };
                            }),
                        };
                    }

                    if (!fullContent) {
                        logger.error("[GroqClient] Empty response");
                        throw new Error("Groq returned no content.");
                    }

                    logger.info(
                        `[GroqClient] Text response (${elapsed} ms)`
                    );

                    llmSpan.setAttribute("llm.response.type", "text");
                    llmSpan.setAttribute("llm.tool_calls", 0);
                    llmSpan.setAttribute("llm.response.length", fullContent.length);
                    llmSpan.addEvent("Natural language response returned");

                    return {
                        type: "text",
                        content: fullContent,
                    };
                } finally {
                    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
                }
            } catch (err) {
                if (signal?.aborted) {
                    console.log("llm.call fetch rejected (before span.end)", signal);
                }
                markSpanError(llmSpan, err);
                throw err;
            } finally {
                signal?.removeEventListener("abort", onAbortEvent);
                llmSpan.end();
            }
        });
    }
}