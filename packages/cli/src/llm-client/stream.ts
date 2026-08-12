// llm-client/stream.ts — streaming infrastructure.
//
// One SSE reader for every provider (Anthropic, Gemini and Bedrock all use
// SSE-style `data:` frames; AWS event-stream frames are unwrapped in the
// bedrock transport before reaching this parser). collectResponse() turns a
// normalized LLMEvent stream into the single LLMResponse the agent consumes.

import { ToolCallingError } from "./errors";
import type { LLMEvent, LLMResponse, ModelSpec, UsageInfo } from "./types";

/** Parse a raw SSE byte/text stream into `data:` payload strings. */
export async function* parseSSE(
    body: ReadableStream<Uint8Array> | null
): AsyncGenerator<string> {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIdx);
                buffer = buffer.slice(newlineIdx + 1);
                const trimmed = line.replace(/\r$/, "");
                if (trimmed.startsWith("data:")) {
                    const payload = trimmed.slice(5).trimStart();
                    if (payload === "[DONE]") return;
                    if (payload) yield payload;
                }
                // blank line separates events; other SSE fields are ignored
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/** Accumulate tool-call deltas by index into finished ToolCalls. */
type PendingToolCall = { index: number; id: string; name: string; args: string };

export function parseToolArguments(name: string, raw: string, index: number): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        throw new Error("tool arguments are not a JSON object");
    } catch (err) {
        throw new ToolCallingError({
            message: `Failed to parse tool arguments for "${name}" (call #${index + 1}).`,
            cause: err,
        });
    }
}

/**
 * Consume a normalized event stream into the LLMResponse the agent loop uses.
 * Tool calls stream as deltas and are assembled by index; the stream may end
 * with a `finish` event or simply close.
 */
export async function collectResponse(
    stream: AsyncIterable<LLMEvent>
): Promise<LLMResponse> {
    let text = "";
    let reasoning = "";
    let usage: UsageInfo | undefined;
    let stopReason: string | undefined;
    const pending = new Map<number, PendingToolCall>();
    const finished: PendingToolCall[] = [];

    for await (const event of stream) {
        switch (event.type) {
            case "text_delta":
                text += event.text;
                break;
            case "reasoning_delta":
                reasoning += event.text;
                break;
            case "usage":
                usage = event.usage;
                break;
            case "tool_call_start":
                pending.set(event.index, {
                    index: event.index,
                    id: event.id,
                    name: event.name,
                    args: "",
                });
                break;
            case "tool_call_delta": {
                const p = pending.get(event.index);
                if (p) p.args += event.argumentsDelta;
                break;
            }
            case "tool_call_end": {
                const p = pending.get(event.index);
                if (p) {
                    pending.delete(event.index);
                    finished.push(p);
                }
                break;
            }
            case "finish":
                stopReason = event.stopReason;
                if (event.usage) usage = event.usage;
                break;
            case "error":
                throw event.error;
        }
    }

    // Tool calls that never received an explicit `end` are still finished.
    for (const p of pending.values()) finished.push(p);
    pending.clear();
    finished.sort((a, b) => a.index - b.index);

    if (finished.length > 0) {
        return {
            type: "tool_calls",
            toolCalls: finished.map((p) => ({
                id: p.id,
                name: p.name,
                args: parseToolArguments(p.name, p.args, p.index),
            })),
            reasoning: reasoning || undefined,
            usage,
        };
    }
    return {
        type: "text",
        content: text,
        reasoning: reasoning || undefined,
        usage,
    };
}

/**
 * Convert a non-streaming LLMResponse into the equivalent normalized events.
 * Used by check-file stubs (and any caller with only a chat()-style response)
 * to feed the same event pipeline the real transports emit.
 */
export async function* eventsFromResponse(response: LLMResponse): AsyncGenerator<LLMEvent> {
    if (response.type === "tool_calls") {
        for (const [index, tc] of response.toolCalls.entries()) {
            yield { type: "tool_call_start", index, id: tc.id, name: tc.name };
            yield { type: "tool_call_delta", index, argumentsDelta: JSON.stringify(tc.args) };
            yield { type: "tool_call_end", index };
        }
    } else if (response.content) {
        yield { type: "text_delta", text: response.content };
    }
    if (response.reasoning) yield { type: "reasoning_delta", text: response.reasoning };
    yield { type: "finish", usage: response.usage };
}

/** Estimate USD cost from usage + model pricing; "unknown" when pricing is absent. */
export function estimateCost(usage: UsageInfo, model?: ModelSpec): number | "unknown" {
    if (!model?.pricing) return "unknown";
    const { pricing } = model;
    const input = usage.inputTokens / 1_000_000;
    const output = usage.outputTokens / 1_000_000;
    const cached = (usage.cachedTokens ?? 0) / 1_000_000;
    const inputRate = pricing.cachedInput !== undefined ? pricing.cachedInput : pricing.input;
    return +(input * inputRate + output * pricing.output).toFixed(6);
}
