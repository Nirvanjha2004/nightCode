import Groq from "groq-sdk";
import type { LLMClient } from "./client";
import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";
import { logger } from "../logger";

export class GroqClient implements LLMClient {
    private client: Groq;

    constructor(apiKey: string) {
        this.client = new Groq({ apiKey });
        logger.info("[GroqClient] Initialized");
    }

    async chat(context: ContextType): Promise<LLMResponse> {
        const messageCount = context.messages.length;
        logger.info(`[GroqClient] Chat request — model=${context.model}, messages=${messageCount}, tools=${context.tools.length}`);

        const startTime = Date.now();

        try {
            const response = await this.client.chat.completions.create({
                model: context.model,
                tools: context.tools,
                tool_choice: "auto",
                messages: [
                    {
                        role: "system",
                        content: context.systemPrompt,
                    },
                    ...context.messages.map((message) => {
                        // Tool result message — toolCallId must exist
                        if (message.role === "tool") {
                            if (!message.toolCallId) {
                                throw new Error(
                                    `Tool message is missing toolCallId (messageId: ${message.messageId})`
                                );
                            }
                            return {
                                role: "tool" as const,
                                tool_call_id: message.toolCallId,
                                content: message.content,
                            };
                        }

                        // Assistant message with tool calls
                        if (message.role === "assistant" && message.toolCalls?.length) {
                            return {
                                role: "assistant" as const,
                                content: message.content || null,
                                tool_calls: message.toolCalls.map((tc) => ({
                                    id: tc.id,
                                    type: "function" as const,
                                    function: {
                                        name: tc.name,
                                        arguments: JSON.stringify(tc.args),
                                    },
                                })),
                            };
                        }

                        // User / plain assistant message
                        return {
                            role: message.role as "user" | "assistant",
                            content: message.content,
                        };
                    }),
                ],
            });

            const elapsed = Date.now() - startTime;

            const message = response.choices[0]?.message;

            if (!message) {
                logger.error(`[GroqClient] Empty choices — elapsed=${elapsed}ms`);
                throw new Error("Groq returned empty choices.");
            }

            // Tool call response
            if (message.tool_calls?.length) {
                const callNames = message.tool_calls.map((tc) => tc.function.name).join(", ");
                logger.info(`[GroqClient] Tool call response — ${message.tool_calls.length} call(s): [${callNames}] (${elapsed}ms)`);

                return {
                    type: "tool_calls",
                    toolCalls: message.tool_calls.map((tc) => ({
                        id: tc.id,
                        name: tc.function.name,
                        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
                    })),
                };
            }

            // Plain text response
            const contentLength = message.content?.length ?? 0;
            logger.info(`[GroqClient] Text response — ${contentLength} chars (${elapsed}ms)`);

            return {
                type: "text",
                content: message.content ?? "",
            };
        } catch (err) {
            const elapsed = Date.now() - startTime;
            logger.error(`[GroqClient] API call failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
            throw err;
        }
    }
}