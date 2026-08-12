// llm-client/transports/openai-compatible.ts
//
// ONE transport for every OpenAI-compatible endpoint: OpenAI, Groq, DeepSeek,
// Together, Fireworks, OpenRouter, Cerebras, Mistral, xAI, NVIDIA NIM, ZAI,
// MiniMax, Kimi, OpenCode Zen/Go, Hugging Face, Cloudflare AI Gateway /
// Workers AI, Vercel AI Gateway, Ollama, llama.cpp, LM Studio, vLLM, and
// custom endpoints. Providers differ only in configuration (baseUrl, key,
// headers, capability flags) — never in the agent core.
//
// Preserves Groq-specific behaviors the original GroqClient had:
//   - tool_use_failed → repair-prompt retry → final no-tools retry
//   - AbortSignal watchdog → cancellation settles in ~ms, never retried

import type { Capabilities, HealthCheckResult, LLMEvent, LLMProvider, LLMResponse, ModelSpec, ProviderConfig, ReasoningEffort, UsageInfo } from "../types";
import type { ContextType } from "../../agent/types";
import { classifyHttpError, extractErrorCode, withRetryStream } from "../errors";
import { collectResponse, estimateCost, parseSSE } from "../stream";
import { fetchWithWatchdog, bodyText, withQuery } from "./http";
import { logger } from "../../logger";
import { tracer } from "../../telemetry";
import { modelSpecFromCustom, withModelOverrides } from "../models";

const TEMPERATURE = 0.1;
const REPAIR_PROMPT = `
IMPORTANT:
Use ONLY the native tool calling interface.
Never emit XML tags such as <function>.
Never emit JSON describing a tool call.
If a tool is needed, use the provided tool interface.
Otherwise answer normally.`;

/** Groq's SDK wraps the API error body: `err.error` is the WHOLE body. */
export function getGroqErrorCode(err: unknown): string | undefined {
    return extractErrorCode(err);
}

export class OpenAICompatibleProvider implements LLMProvider {
    readonly providerId: string;
    readonly displayName: string;
    readonly config: ProviderConfig;
    protected readonly apiKey?: string;
    private readonly flags: Partial<Capabilities>;

    constructor(config: ProviderConfig, apiKey?: string) {
        this.config = config;
        this.providerId = config.providerId;
        this.displayName = config.displayName;
        this.apiKey = apiKey;
        this.flags = config.flags ?? {};
    }

    // ── Models ─────────────────────────────────────────────────────────
    listModels(): ModelSpec[] {
        return withModelOverrides(this.config.models, this.config.modelOverrides);
    }

    getModel(modelId: string): ModelSpec {
        const models = this.listModels();
        const found = models.find((m) => m.id === modelId);
        if (found) return found;
        // Fallback for model ids not in the catalog (e.g. discovery results,
        // custom endpoints): conservative defaults + known capability flags.
        const base = {
            id: modelId,
            name: modelId,
            provider: this.providerId,
            contextWindow: this.flags.maxContextTokens ?? 128_000,
            maxOutputTokens: this.flags.maxOutputTokens ?? 8192,
            inputModalities: ["text"] as const,
            outputModalities: ["text"] as const,
            reasoning: this.flags.reasoning ?? false,
            reasoningEffort: this.flags.reasoningEffort ?? false,
            toolCalling: this.flags.toolCalling ?? true,
            vision: this.flags.vision ?? false,
            structuredOutput: this.flags.structuredOutput ?? false,
            parallelToolCalls: this.flags.parallelToolCalls ?? true,
            developerMessages: this.flags.developerMessages ?? false,
        };
        return base as unknown as ModelSpec;
    }

    capabilities(modelId: string): Capabilities {
        const m = this.getModel(modelId);
        return {
            streaming: this.flags.streaming !== false,
            toolCalling: m.toolCalling,
            parallelToolCalls: m.parallelToolCalls,
            reasoning: m.reasoning,
            reasoningEffort: m.reasoningEffort,
            vision: m.vision,
            structuredOutput: m.structuredOutput,
            systemMessages: true,
            developerMessages: m.developerMessages,
            maxContextTokens: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
        };
    }

    summarizerModel(): string {
        return this.config.summarizerModel ?? this.config.models[0]?.id ?? "gpt-4o-mini";
    }

    subagentModel(): string {
        return this.config.subagentModel ?? this.config.models[0]?.id ?? "gpt-4o-mini";
    }

    // ── Request building ────────────────────────────────────────────────

    protected baseUrl(): string {
        let url = this.config.baseUrl ?? "https://api.openai.com/v1";
        if (this.config.placeholders) {
            for (const [k, v] of Object.entries(this.config.placeholders)) {
                url = url.replaceAll(`{${k}}`, encodeURIComponent(v));
            }
        }
        return url.replace(/\/$/, "");
    }

    protected headers(): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            ...this.config.headers,
        };
        if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
        return h;
    }

    /** Wire model id — Azure substitutes the deployment name here. */
    protected wireModel(modelId: string): string {
        return modelId;
    }

    /** Full chat-completions URL — Azure appends its api-version query. */
    protected chatCompletionsUrl(): string {
        return `${this.baseUrl()}/chat/completions`;
    }

    private buildMessages(context: ContextType, repairMode: "none" | "repair" | "no-tools") {
        const dev = this.getModel(context.model).developerMessages;
        const systemRole = dev ? "developer" : "system";

        const messages: Array<Record<string, unknown>> = [
            {
                role: systemRole,
                content:
                    context.systemPrompt +
                    (repairMode === "repair" ? REPAIR_PROMPT : "") +
                    (repairMode === "no-tools"
                        ? `\n\nIMPORTANT:\nTool calling is currently unavailable. Answer the user's request directly in plain text based on the conversation so far.`
                        : ""),
            },
        ];

        for (const message of context.messages) {
            if (message.role === "tool") {
                messages.push({
                    role: "tool",
                    tool_call_id: message.toolCallId ?? "",
                    content: message.content,
                });
                continue;
            }
            if (message.role === "assistant" && message.toolCalls?.length) {
                messages.push({
                    role: "assistant",
                    content: message.content || null,
                    tool_calls: message.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.args),
                        },
                    })),
                });
                continue;
            }
            messages.push({ role: message.role, content: message.content });
        }
        return messages;
    }

    // ── Streaming ──────────────────────────────────────────────────────

    async *stream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        yield* withRetryStream(
            () => this.rawStream(context, signal),
            {
                maxRetries: 2,
                onRetry: (err, attempt, delay) =>
                    logger.warn(`[${this.providerId}] retry ${attempt} after ${Math.round(delay)}ms: ${(err as Error).message}`),
            },
            signal
        );
    }

    private async *rawStream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        const spec = this.getModel(context.model);
        const model = this.wireModel(context.model);
        const effort: ReasoningEffort = (context.reasoningEffort as ReasoningEffort) ?? this.config.defaultReasoningEffort ?? "off";
        const streaming = this.flags.streaming !== false;

        const body: Record<string, unknown> = {
            model,
            messages: this.buildMessages(context, "none"),
            temperature: TEMPERATURE,
            ...this.config.requestOverrides,
        };

        if (context.tools.length > 0 && spec.toolCalling) {
            body.tools = context.tools;
            body.tool_choice = "auto";
            if (!spec.parallelToolCalls) body.parallel_tool_calls = false;
        }
        if (spec.reasoning && spec.reasoningEffort && effort !== "off") {
            body.reasoning_effort = effort;
        }
        if (context.jsonMode && spec.structuredOutput) {
            body.response_format = { type: "json_object" };
        }
        if (streaming) {
            body.stream = true;
            if (this.config.includeStreamUsage !== false) {
                body.stream_options = { include_usage: true };
            }
        }

        const started = Date.now();
        const span = tracer.startSpan("llm.call");
        span.setAttribute("llm.provider", this.providerId);
        span.setAttribute("llm.model", model);

        try {
            const res = await fetchWithWatchdog(
                this.chatCompletionsUrl(),
                {
                    method: "POST",
                    headers: this.headers(),
                    body: JSON.stringify(body),
                    signal,
                },
                { signal }
            );

            if (!res.ok) {
                const raw = await bodyText(res);
                const err = classifyHttpError({
                    status: res.status,
                    body: raw,
                    provider: this.providerId,
                    model,
                    retryAfterMs: retryAfterMs(res),
                });
                span.recordException(err);
                throw err;
            }

            span.addEvent("request accepted");

            if (!streaming) {
                const data = (await res.json()) as {
                    choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }>;
                    usage?: Record<string, number>;
                };
                const msg = data.choices?.[0]?.message;
                if (msg?.tool_calls?.length) {
                    for (const tc of msg.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
                        yield { type: "tool_call_start", index: 0, id: tc.id ?? "call_0", name: tc.function?.name ?? "" };
                        if (tc.function?.arguments) {
                            yield { type: "tool_call_delta", index: 0, argumentsDelta: tc.function.arguments };
                        }
                        yield { type: "tool_call_end", index: 0 };
                    }
                } else {
                    yield { type: "text_delta", text: msg?.content ?? "" };
                }
                yield { type: "finish", stopReason: data.choices?.[0]?.finish_reason ?? undefined, usage: this.mapUsage(data.usage, spec) };
                return;
            }

            // ── Streaming ─────────────────────────────────────────────
            const startedCalls = new Set<number>();
            let stopReason: string | undefined;
            let usage: UsageInfo | undefined;

            for await (const payload of parseSSE(res.body)) {
                let chunk: {
                    choices?: Array<{
                        delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
                        finish_reason?: string | null;
                    }>;
                    usage?: Record<string, number>;
                    error?: { message?: string };
                };
                try {
                    chunk = JSON.parse(payload);
                } catch {
                    continue;
                }
                if (chunk.error) {
                    throw classifyHttpError({
                        status: 400,
                        body: JSON.stringify(chunk.error),
                        provider: this.providerId,
                        model,
                    });
                }
                // OpenAI emits usage on the FINAL chunk (with include_usage) —
                // capture it whether or not that chunk carries a choice.
                if (chunk.usage) usage = this.mapUsage(chunk.usage, spec);
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta ?? {};

                if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                    yield { type: "reasoning_delta", text: delta.reasoning_content };
                }
                if (typeof delta.content === "string" && delta.content) {
                    yield { type: "text_delta", text: delta.content };
                }
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const index = tc.index ?? 0;
                        if (!startedCalls.has(index)) {
                            startedCalls.add(index);
                            yield {
                                type: "tool_call_start",
                                index,
                                id: tc.id ?? `call_${index}`,
                                name: tc.function?.name ?? "",
                            };
                        }
                        if (tc.function?.arguments) {
                            yield { type: "tool_call_delta", index, argumentsDelta: tc.function.arguments };
                        }
                    }
                }
                if (choice.finish_reason) {
                    stopReason = choice.finish_reason;
                }
            }

            span.setAttribute("llm.response.length", "streamed");
            yield { type: "finish", stopReason, usage };
        } catch (err) {
            span.recordException(err as Error);
            throw err;
        } finally {
            span.setAttribute("llm.latency_ms", Date.now() - started);
            span.end();
        }
    }

    // ── Non-streaming convenience ──────────────────────────────────────

    async chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse> {
        try {
            return await collectResponse(this.stream(context, signal));
        } catch (err) {
            if (signal?.aborted) throw err;
            // Groq-style tool-call repair: the model emitted a malformed tool
            // call; replay with a repair prompt, then retry without tools.
            // ponytail: the original Groq client replayed the rejected
            // generation back as feedback; the repair prompt alone covers the
            // same recovery with a smaller diff.
            if (this.config.repairToolCalls && extractErrorCode(err) === "tool_use_failed") {
                logger.warn(`[${this.providerId}] tool_use_failed — retrying with tool-calling repair prompt`);
                try {
                    return await collectResponse(
                        this.stream({ ...context, systemPrompt: context.systemPrompt + REPAIR_PROMPT }, signal)
                    );
                } catch (repairErr) {
                    if (signal?.aborted) throw repairErr;
                    if (extractErrorCode(repairErr) === "tool_use_failed") {
                        logger.warn(`[${this.providerId}] repair retry failed too — retrying without tools (text-only)`);
                        return await collectResponse(
                            this.stream(
                                {
                                    ...context,
                                    tools: [],
                                    systemPrompt:
                                        context.systemPrompt +
                                        `\n\nIMPORTANT:\nTool calling is currently unavailable. Answer the user's request directly in plain text based on the conversation so far.`,
                                },
                                signal
                            )
                        );
                    }
                    throw repairErr;
                }
            }
            throw err;
        }
    }

    private mapUsage(u: Record<string, number> | undefined, spec: ModelSpec): UsageInfo | undefined {
        if (!u) return undefined;
        const inputTokens = u.prompt_tokens ?? 0;
        const outputTokens = u.completion_tokens ?? 0;
        const cachedTokens = (u.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens;
        const reasoningTokens = (u.completion_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
        const usage: UsageInfo = {
            inputTokens,
            outputTokens,
            reasoningTokens,
            cachedTokens,
            totalTokens: u.total_tokens ?? inputTokens + outputTokens,
            estimatedCost: "unknown",
        };
        usage.estimatedCost = estimateCost(usage, spec);
        return usage;
    }

    // ── Health / discovery ─────────────────────────────────────────────

    async healthCheck(): Promise<HealthCheckResult> {
        const started = Date.now();
        try {
            const res = await fetchWithWatchdog(
                withQuery(`${this.baseUrl()}/models`, { limit: 1 }),
                { method: "GET", headers: this.headers(), signal: undefined },
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
        if (this.config.discoveryApi === "ollama-tags") {
            return this.discoverOllama();
        }
        try {
            const base = this.baseUrl();
            // Ollama's OpenAI-compatible endpoint also exposes /v1/models — but
            // its native /api/tags is the richer list; covered above.
            const res = await fetchWithWatchdog(
                withQuery(`${base}/models`, { limit: 100 }),
                { method: "GET", headers: this.headers() },
                { timeoutMs: 8000 }
            );
            if (!res.ok) return null;
            const data = (await res.json()) as { data?: Array<{ id?: string; object?: string }> };
            if (!Array.isArray(data.data)) return null;
            const known = new Set(this.listModels().map((m) => m.id));
            const discovered: ModelSpec[] = [];
            for (const item of data.data) {
                if (!item.id || known.has(item.id)) continue;
                const spec = this.getModel(item.id);
                discovered.push({ ...spec, name: item.id });
            }
            return discovered;
        } catch (err) {
            logger.debug(`[${this.providerId}] model discovery failed: ${(err as Error).message}`);
            return null;
        }
    }

    private async discoverOllama(): Promise<ModelSpec[] | null> {
        try {
            // baseUrl is http://host:11434/v1 — tags live at the origin root.
            const origin = this.baseUrl().replace(/\/v1$/, "");
            const res = await fetchWithWatchdog(
                `${origin}/api/tags`,
                { method: "GET" },
                { timeoutMs: 8000 }
            );
            if (!res.ok) return null;
            const data = (await res.json()) as { models?: Array<{ name?: string }> };
            if (!Array.isArray(data.models)) return null;
            const known = new Set(this.listModels().map((m) => m.id));
            return data.models
                .map((m) => m.name)
                .filter((name): name is string => !!name && !known.has(name))
                .map((name) => {
                    const lower = name.toLowerCase();
                    return modelSpecFromCustom("ollama", {
                        id: name,
                        name,
                        reasoning: /r1|reasoning|thinking/.test(lower),
                        vision: /vision|vl\b|llava/.test(lower),
                    });
                });
        } catch (err) {
            logger.debug(`[ollama] model discovery failed: ${(err as Error).message}`);
            return null;
        }
    }
}

function retryAfterMs(res: Response): number | undefined {
    const value = res.headers.get("retry-after");
    if (!value) return undefined;
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
    return undefined;
}
