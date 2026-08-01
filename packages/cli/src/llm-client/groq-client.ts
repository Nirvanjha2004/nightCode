import Groq from "groq-sdk";

import type { LLMClient } from "./client";
import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

import { logger } from "../logger";
import { markSpanError, tracer } from "../telemetry";

const LLM_TEMPERATURE = 0.1;

export class GroqClient implements LLMClient {
    private client: Groq;

    constructor(apiKey: string) {
        this.client = new Groq({ apiKey });
        logger.info("[GroqClient] Initialized");
    }

    async chat(context: ContextType): Promise<LLMResponse> {
        logger.info(
            `[GroqClient] Chat request | model=${context.model} | messages=${context.messages.length} | tools=${context.tools.length}`
        );

        try {
            return await this.callGroq(context);
        } catch (err: any) {
            const code = err?.error?.code ?? err?.code;

            logger.error(
                `[GroqClient] Request failed (${code ?? "unknown"}) : ${
                    err?.message ?? err
                }`
            );

            if (code === "tool_use_failed") {
                logger.warn(
                    "[GroqClient] Retrying once with tool-calling repair prompt"
                );

                return await this.callGroq({
                    ...context,
                    systemPrompt:
                        context.systemPrompt +
                        `

IMPORTANT:
Use ONLY the native tool calling interface.
Never emit XML tags such as <function>.
Never emit JSON describing a tool call.
If a tool is needed, use the provided tool interface.
Otherwise answer normally.`,
                });
            }

            throw err;
        }
    }

    private async callGroq(
        context: ContextType
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

                    tool_choice: "auto",

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
                });

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