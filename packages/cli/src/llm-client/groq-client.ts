import Groq from "groq-sdk";
import type { LLMClient } from "./client";
import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

export class GroqClient implements LLMClient {
    private client: Groq;

    constructor(apiKey: string) {
        this.client = new Groq({ apiKey });
    }

    async chat(context: ContextType): Promise<LLMResponse> {
        const response = await this.client.chat.completions.create({
            model: context.model,
            tools: context.tools,   // must be passed or Groq never returns tool_calls
            messages: [
                {
                    role: "system",
                    content: context.systemPrompt,
                },
                ...context.messages.map((message) => {
                    // Tool result message — toolCallId must exist, never fallback
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

                    // Assistant message with tool calls — must include tool_calls array
                    // otherwise Groq loses context of what was called in history
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

        const message = response.choices[0]?.message;

        if (!message) {
            throw new Error("Groq returned empty choices.");
        }

        // Tool call response — parse and return tool_call type
        if (message.tool_calls?.length) {
            return {
                type: "tool_call",
                toolCall: message.tool_calls.map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                    args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
                })),
            };
        }

        // Plain text response
        return {
            type: "text",
            content: message.content ?? "",
        };
    }
}