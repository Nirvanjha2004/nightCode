import Groq from "groq-sdk";

import type { LLMClient } from "./client";
import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

export class GroqClient implements LLMClient {
    private client: Groq;

    constructor(apiKey: string) {
        this.client = new Groq({
            apiKey,
        });
    }

    async generate(context: ContextType): Promise<LLMResponse> {
        const response = await this.client.chat.completions.create({
            model: context.model,

            messages: [
                {
                    role: "system",
                    content: context.systemPrompt,
                },
                ...context.messages.map((message) => ({
                    role: message.role as
                        | "system"
                        | "user"
                        | "assistant"
                        | "tool",
                    content: message.content,
                })),
            ],
        });

        const message = response.choices[0].message;

        return {
            type: "text",
            content: message.content ?? "",
        };
    }
}