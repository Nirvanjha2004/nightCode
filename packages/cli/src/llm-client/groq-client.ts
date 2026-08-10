import Groq from "groq-sdk";

import type { LLMClient } from "./client";
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

    async chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse> {
        logger.info(
            `[GroqClient] Chat request | model=${context.model} | messages=${context.messages.length} | tools=${context.tools.length}`
        );

        try {
            return await this.callGroq(context, "auto", signal);
        } catch (err: any) {
            // Cancellation via AbortSignal is NOT an API failure — surface it
            // untouched (no retry, no repair prompt, no error log).
            if (signal?.aborted) throw err;

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
                        signal
                    );
                } catch (repairErr: any) {
                    if (signal?.aborted) throw repairErr;

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
                            signal
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
        signal?: AbortSignal
    ): Promise<LLMResponse> {
        return tracer.startActiveSpan("llm.call", async (llmSpan): Promise<LLMResponse> => {
            try {
                const started = Date.now();

                llmSpan.setAttribute("llm.provider", "groq");
                llmSpan.setAttribute("llm.model", context.model);
                llmSpan.setAttribute("llm.temperature", LLM_TEMPERATURE);
                // llm.max_tokens is intentionally omitted: the request never sends
                // max_tokens, so there is no value to attribute.
                llmSpan.addEvent("Sending request to LLM");

                const response = await this.client.chat.completions.create({
                    model: context.model,

                    tools: context.tools,

                    tool_choice: toolChoice,

                    temperature: LLM_TEMPERATURE,

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

                const elapsed = Date.now() - started;

                // Token usage (if the provider returns it)
                if (response.usage) {
                    llmSpan.setAttribute("llm.input_tokens", response.usage.prompt_tokens);
                    llmSpan.setAttribute("llm.output_tokens", response.usage.completion_tokens);
                    llmSpan.setAttribute("llm.total_tokens", response.usage.total_tokens);
                }

                const message = response.choices[0]?.message;

                if (!message) {
                    logger.error("[GroqClient] Empty response");
                    throw new Error("Groq returned no message.");
                }

                llmSpan.addEvent("Response received");

                if (message.tool_calls?.length) {
                    logger.info(
                        `[GroqClient] ${message.tool_calls.length} tool call(s) generated (${elapsed} ms)`
                    );

                    llmSpan.setAttribute("llm.response.type", "tool_calls");
                    llmSpan.setAttribute("llm.tool_calls", message.tool_calls.length);
                    llmSpan.setAttribute("llm.response.length", message.tool_calls.length);
                    llmSpan.addEvent("Tool calls requested");

                    return {
                        type: "tool_calls",

                        toolCalls: message.tool_calls.map((toolCall) => {
                            if (!toolCall.id) {
                                throw new Error(
                                    "Tool call missing id"
                                );
                            }

                            if (!toolCall.function?.name) {
                                throw new Error(
                                    "Tool call missing function name"
                                );
                            }

                            let args: Record<string, unknown>;

                            try {
                                args = JSON.parse(
                                    toolCall.function.arguments
                                );
                            } catch {
                                throw new Error(
                                    `Failed to parse tool arguments for "${toolCall.function.name}"`
                                );
                            }

                            return {
                                id: toolCall.id,
                                name: toolCall.function.name,
                                args,
                            };
                        }),
                    };
                }

                logger.info(
                    `[GroqClient] Text response (${elapsed} ms)`
                );

                llmSpan.setAttribute("llm.response.type", "text");
                llmSpan.setAttribute("llm.tool_calls", 0);
                llmSpan.setAttribute("llm.response.length", (message.content ?? "").length);
                llmSpan.addEvent("Natural language response returned");

                return {
                    type: "text",
                    content: message.content ?? "",
                };
            } catch (err) {
                markSpanError(llmSpan, err);
                throw err;
            } finally {
                llmSpan.end();
            }
        });
    }
}