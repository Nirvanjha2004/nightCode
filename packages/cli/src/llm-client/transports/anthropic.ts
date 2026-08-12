// llm-client/transports/anthropic.ts — dedicated Anthropic adapter.
//
// Anthropic's semantics differ from OpenAI's (system field, tool_use /
// tool_result content blocks, mandatory max_tokens, extended thinking), so it
// gets its own transport instead of being forced through the OpenAI one.

import type { HealthCheckResult, LLMEvent, LLMProvider, LLMResponse, ModelSpec, ProviderConfig, ReasoningEffort, UsageInfo } from "../types";
import type { ContextType } from "../../agent/types";
import { classifyHttpError, withRetryStream } from "../errors";
import { collectResponse, estimateCost, parseSSE } from "../stream";
import { fetchWithWatchdog, bodyText } from "./http";
import { withModelOverrides } from "../models";
import { logger } from "../../logger";

const API_VERSION = "2023-06-01";

type AnthropicContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: string };

// thinking budget per reasoning-effort level (Anthropic extended thinking)
const THINKING_BUDGET: Record<Exclude<ReasoningEffort, "off">, number> = {
    low: 2048,
    medium: 4096,
    high: 8192,
    max: 16_384,
};

export class AnthropicProvider implements LLMProvider {
    readonly providerId: string;
    readonly displayName: string;
    readonly config: ProviderConfig;
    private readonly apiKey?: string;

    constructor(config: ProviderConfig, apiKey?: string) {
        this.config = config;
        this.providerId = config.providerId;
        this.displayName = config.displayName;
        this.apiKey = apiKey;
    }

    listModels(): ModelSpec[] {
        return withModelOverrides(this.config.models, this.config.modelOverrides);
    }

    getModel(modelId: string): ModelSpec {
        const found = this.listModels().find((m) => m.id === modelId);
        if (found) return found;
        return {
            id: modelId,
            name: modelId,
            provider: this.providerId,
            contextWindow: 200_000,
            maxOutputTokens: 8192,
            inputModalities: ["text"],
            outputModalities: ["text"],
            reasoning: true,
            reasoningEffort: false,
            toolCalling: true,
            vision: true,
            structuredOutput: false,
            parallelToolCalls: true,
            developerMessages: false,
        };
    }

    capabilities(modelId: string) {
        const m = this.getModel(modelId);
        return {
            streaming: true,
            toolCalling: m.toolCalling,
            parallelToolCalls: m.parallelToolCalls,
            reasoning: m.reasoning,
            reasoningEffort: false,
            vision: m.vision,
            structuredOutput: false,
            systemMessages: true,
            developerMessages: false,
            maxContextTokens: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
        };
    }

    summarizerModel(): string {
        return this.config.summarizerModel ?? "claude-haiku-4-5";
    }

    subagentModel(): string {
        return this.config.subagentModel ?? "claude-haiku-4-5";
    }

    private buildSystem(context: ContextType): string {
        const summary = context.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");
        return summary ? `${context.systemPrompt}\n\n${summary}` : context.systemPrompt;
    }

    private buildMessages(context: ContextType): Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> {
        const out: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> = [];

        // Append a wire message, merging consecutive same-role messages into a
        // single content array (Anthropic requires strict user/assistant
        // alternation — parallel tool results would otherwise violate it).
        const push = (msg: { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }) => {
            const last = out[out.length - 1];
            if (last && last.role === msg.role && Array.isArray(last.content)) {
                const blocks = typeof msg.content === "string"
                    ? [{ type: "text" as const, text: msg.content }]
                    : msg.content;
                last.content = [...last.content, ...blocks];
            } else {
                out.push(msg);
            }
        };

        for (const message of context.messages) {
            if (message.role === "system") continue; // folded into the system field

            if (message.role === "tool") {
                push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content }] });
                continue;
            }

            if (message.role === "assistant" && message.toolCalls?.length) {
                const blocks: AnthropicContentBlock[] = [];
                if (message.content) blocks.push({ type: "text", text: message.content });
                for (const tc of message.toolCalls) {
                    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
                }
                push({ role: "assistant", content: blocks });
                continue;
            }

            push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
        }
        return out;
    }

    async *stream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        yield* withRetryStream(
            () => this.rawStream(context, signal),
            {
                maxRetries: 2,
                onRetry: (err, attempt, delay) =>
                    logger.warn(`[anthropic] retry ${attempt} after ${Math.round(delay)}ms: ${(err as Error).message}`),
            },
            signal
        );
    }

    private async *rawStream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        const spec = this.getModel(context.model);
        const effort: ReasoningEffort = (context.reasoningEffort as ReasoningEffort) ?? this.config.defaultReasoningEffort ?? "off";
        const useThinking = spec.reasoning && effort !== "off";

        const body: Record<string, unknown> = {
            model: context.model,
            max_tokens: spec.maxOutputTokens,
            system: this.buildSystem(context),
            messages: this.buildMessages(context),
            stream: true,
            ...this.config.requestOverrides,
        };

        const wireTools = context.tools.length > 0 && spec.toolCalling;
        if (wireTools) {
            body.tools = context.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
            }));
            body.tool_choice = { type: "auto" };
        }
        if (useThinking) {
            body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET[effort as Exclude<ReasoningEffort, "off">] };
        }

        const res = await fetchWithWatchdog(
            `${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-api-key": this.apiKey ?? "",
                    "anthropic-version": this.config.headers?.["anthropic-version"] ?? API_VERSION,
                    ...this.config.headers,
                },
                body: JSON.stringify(body),
                signal,
            },
            { signal }
        );

        if (!res.ok) {
            const raw = await bodyText(res);
            throw classifyHttpError({
                status: res.status,
                body: raw,
                provider: this.providerId,
                model: context.model,
                retryAfterMs: retryAfterMsMs(res),
            });
        }

        // ── SSE event mapping ─────────────────────────────────────────
        let stopReason: string | undefined;
        let usage: UsageInfo | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        let reasoningTokens = 0;
        let currentTool: { index: number; id: string; name: string } | null = null;

        for await (const payload of parseSSE(res.body)) {
            let event: Record<string, unknown>;
            try {
                event = JSON.parse(payload);
            } catch {
                continue;
            }
            switch (event.type) {
                case "message_start": {
                    const u = event.message as { usage?: { input_tokens?: number } } | undefined;
                    inputTokens = u?.usage?.input_tokens ?? 0;
                    break;
                }
                case "content_block_start": {
                    const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
                    if (block?.type === "tool_use") {
                        currentTool = { index: 0, id: block.id ?? `call_0`, name: block.name ?? "" };
                        yield { type: "tool_call_start", index: 0, id: currentTool.id, name: currentTool.name };
                    }
                    break;
                }
                case "content_block_delta": {
                    const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
                    if (delta?.type === "text_delta" && delta.text) {
                        yield { type: "text_delta", text: delta.text };
                    } else if (delta?.type === "thinking_delta" && delta.text) {
                        reasoningTokens += estimateTokenLength(delta.text);
                        yield { type: "reasoning_delta", text: delta.text };
                    } else if (delta?.type === "input_json_delta" && delta.partial_json) {
                        yield { type: "tool_call_delta", index: currentTool?.index ?? 0, argumentsDelta: delta.partial_json };
                    }
                    break;
                }
                case "content_block_stop": {
                    if (currentTool) {
                        yield { type: "tool_call_end", index: currentTool.index };
                        currentTool = null;
                    }
                    break;
                }
                case "message_delta": {
                    const d = event.delta as { stop_reason?: string } | undefined;
                    const u = event.usage as { output_tokens?: number } | undefined;
                    if (d?.stop_reason) stopReason = d.stop_reason;
                    outputTokens = u?.output_tokens ?? outputTokens;
                    break;
                }
                case "message_stop":
                    break;
                case "error": {
                    const e = event.error as { type?: string; message?: string } | undefined;
                    if (e?.type === "overloaded_error") {
                        throw classifyHttpError({ status: 529, body: JSON.stringify(e), provider: this.providerId, model: context.model });
                    }
                    throw classifyHttpError({ status: 400, body: JSON.stringify(e), provider: this.providerId, model: context.model });
                }
            }
        }

        usage = {
            inputTokens,
            outputTokens,
            reasoningTokens: reasoningTokens || undefined,
            totalTokens: inputTokens + outputTokens,
            estimatedCost: "unknown",
        };
        usage.estimatedCost = estimateCost(usage, spec);
        yield { type: "finish", stopReason, usage };
    }

    async chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse> {
        return collectResponse(this.stream(context, signal));
    }

    async healthCheck(): Promise<HealthCheckResult> {
        const started = Date.now();
        try {
            const res = await fetchWithWatchdog(
                `${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/models`,
                {
                    method: "GET",
                    headers: {
                        "x-api-key": this.apiKey ?? "",
                        "anthropic-version": API_VERSION,
                    },
                },
                { timeoutMs: 10_000 }
            );
            if (res.ok) return { ok: true, latencyMs: Date.now() - started };
            if (res.status === 401 || res.status === 403) {
                return { ok: false, auth: true, error: `Authentication failed (HTTP ${res.status})` };
            }
            return { ok: false, error: `HTTP ${res.status}` };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    async discoverModels(): Promise<ModelSpec[] | null> {
        return null; // Anthropic has no public model-list endpoint — static catalog only
    }
}

/** Rough token estimate for thinking text (usage isn't reported for thinking deltas). */
function estimateTokenLength(text: string): number {
    return Math.ceil(text.length / 4);
}

function retryAfterMsMs(res: Response): number | undefined {
    const value = res.headers.get("retry-after");
    if (!value) return undefined;
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
    return undefined;
}
