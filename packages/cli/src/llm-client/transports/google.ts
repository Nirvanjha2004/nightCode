// llm-client/transports/google.ts — dedicated Gemini adapter.
//
// Gemini speaks parts + functionDeclarations rather than messages + tools, so
// it gets its own transport. Vertex AI reuses this transport with a different
// base URL and an OAuth bearer token (see vertex.ts).

import type { HealthCheckResult, LLMEvent, LLMProvider, LLMResponse, ModelSpec, ProviderConfig, ReasoningEffort, UsageInfo } from "../types";
import type { ContextType } from "../../agent/types";
import { classifyHttpError, withRetryStream } from "../errors";
import { collectResponse, estimateCost, parseSSE } from "../stream";
import { fetchWithWatchdog, bodyText, withQuery } from "./http";
import { withModelOverrides } from "../models";
import { logger } from "../../logger";

type GeminiPart =
    | { text: string }
    | { thought?: boolean; text?: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

const THINKING_BUDGET: Record<Exclude<ReasoningEffort, "off">, number> = {
    low: 1024,
    medium: 4096,
    high: 8192,
    max: 32_768,
};

export class GoogleProvider implements LLMProvider {
    readonly providerId: string;
    readonly displayName: string;
    readonly config: ProviderConfig;
    protected readonly apiKey?: string;

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
            contextWindow: 1_048_576,
            maxOutputTokens: 8192,
            inputModalities: ["text"],
            outputModalities: ["text"],
            reasoning: true,
            reasoningEffort: false,
            toolCalling: true,
            vision: true,
            structuredOutput: true,
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
            structuredOutput: m.structuredOutput,
            systemMessages: true,
            developerMessages: false,
            maxContextTokens: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
        };
    }

    summarizerModel(): string {
        return this.config.summarizerModel ?? "gemini-2.5-flash-lite";
    }

    subagentModel(): string {
        return this.config.subagentModel ?? "gemini-2.5-flash-lite";
    }

    /** Default Gemini endpoint; Vertex overrides this. Honors a custom baseUrl (mock servers, proxies). */
    protected endpoint(model: string): string {
        const base = this.config.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
        return `${base}/models/${encodeURIComponent(model)}:streamGenerateContent`;
    }

    /** Async so Vertex can attach an OAuth bearer token before each call. */
    protected async resolveAuthHeaders(): Promise<Record<string, string>> {
        const h: Record<string, string> = { "Content-Type": "application/json" };
        if (this.apiKey) h["x-goog-api-key"] = this.apiKey;
        return { ...h, ...this.config.headers };
    }

    private buildSystem(context: ContextType): string {
        const summary = context.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");
        return summary ? `${context.systemPrompt}\n\n${summary}` : context.systemPrompt;
    }

    private buildContents(context: ContextType): GeminiContent[] {
        const out: GeminiContent[] = [];
        const pendingNames = new Map<string, string>(); // toolCallId → function name

        const push = (content: GeminiContent) => {
            const last = out[out.length - 1];
            if (last && last.role === content.role) {
                last.parts.push(...content.parts);
            } else {
                out.push(content);
            }
        };

        for (const message of context.messages) {
            if (message.role === "system") continue; // folded into systemInstruction

            if (message.role === "tool") {
                const name = pendingNames.get(message.toolCallId ?? "") ?? "tool";
                // Gemini's function_response.response is a protobuf Struct — it must
                // be a JSON object, never a bare string. Parse the tool output when
                // it is JSON; otherwise wrap it in { result: ... }.
                let response: Record<string, unknown>;
                try {
                    const parsed = JSON.parse(message.content) as unknown;
                    response =
                        parsed && typeof parsed === "object" && !Array.isArray(parsed)
                            ? (parsed as Record<string, unknown>)
                            : { result: parsed };
                } catch {
                    response = { result: message.content };
                }
                push({
                    role: "user",
                    parts: [{ functionResponse: { name, response } }],
                });
                continue;
            }

            if (message.role === "assistant" && message.toolCalls?.length) {
                const parts: GeminiPart[] = [];
                if (message.content) parts.push({ text: message.content });
                for (const tc of message.toolCalls) {
                    pendingNames.set(tc.id, tc.name);
                    parts.push({ functionCall: { name: tc.name, args: tc.args } });
                }
                push({ role: "model", parts });
                continue;
            }

            push({
                role: message.role === "assistant" ? "model" : "user",
                parts: [{ text: message.content }],
            });
        }
        return out;
    }

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
        const effort: ReasoningEffort = (context.reasoningEffort as ReasoningEffort) ?? this.config.defaultReasoningEffort ?? "off";

        const body: Record<string, unknown> = {
            systemInstruction: { parts: [{ text: this.buildSystem(context) }] },
            contents: this.buildContents(context),
            ...this.config.requestOverrides,
        };

        if (context.tools.length > 0 && spec.toolCalling) {
            body.tools = [
                {
                    functionDeclarations: context.tools.map((t) => ({
                        name: t.function.name,
                        description: t.function.description,
                        parameters: t.function.parameters,
                    })),
                },
            ];
        }

        const generationConfig: Record<string, unknown> = {
            temperature: 0.1,
            maxOutputTokens: spec.maxOutputTokens,
        };
        if (spec.reasoning) {
            generationConfig.thinkingConfig = {
                thinkingBudget: effort === "off" ? 0 : THINKING_BUDGET[effort as Exclude<ReasoningEffort, "off">],
            };
        }
        body.generationConfig = generationConfig;

        const res = await fetchWithWatchdog(
            withQuery(this.endpoint(context.model), { alt: "sse" }),
            {
                method: "POST",
                headers: await this.resolveAuthHeaders(),
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

        // ── SSE mapping: parts → normalized events ────────────────────
        const functionCalls = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();
        let stopReason: string | undefined;
        let usage: UsageInfo | undefined;

        for await (const payload of parseSSE(res.body)) {
            let chunk: {
                candidates?: Array<{
                    content?: { parts?: GeminiPart[]; role?: string };
                    finishReason?: string;
                }>;
                usageMetadata?: {
                    promptTokenCount?: number;
                    candidatesTokenCount?: number;
                    thoughtsTokenCount?: number;
                    cachedContentTokenCount?: number;
                    totalTokenCount?: number;
                };
                error?: { message?: string; status?: string };
            };
            try {
                chunk = JSON.parse(payload);
            } catch {
                continue;
            }
            if (chunk.error) {
                throw classifyHttpError({ status: 400, body: JSON.stringify(chunk.error), provider: this.providerId, model: context.model });
            }

            const candidate = chunk.candidates?.[0];
            if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                    if ("thought" in part && part.thought && part.text) {
                        yield { type: "reasoning_delta", text: part.text };
                    } else if ("text" in part && part.text) {
                        yield { type: "text_delta", text: part.text };
                    } else if ("functionCall" in part && part.functionCall) {
                        const fc = part.functionCall;
                        const existing = functionCalls.get(fc.name);
                        if (!existing) {
                            // first appearance — assign an id and emit start
                            const id = `call_${functionCalls.size + 1}`;
                            functionCalls.set(fc.name, { id, name: fc.name, args: {} });
                            yield { type: "tool_call_start", index: functionCalls.size - 1, id, name: fc.name };
                        }
                        // args may accumulate across chunks — keep the latest
                        const entry = functionCalls.get(fc.name)!;
                        entry.args = { ...entry.args, ...fc.args };
                        yield { type: "tool_call_delta", index: [...functionCalls.keys()].indexOf(fc.name), argumentsDelta: JSON.stringify(entry.args) };
                    }
                }
            }
            if (candidate?.finishReason) {
                stopReason = candidate.finishReason;
            }
            if (chunk.usageMetadata) {
                const u = chunk.usageMetadata;
                const usageInfo: UsageInfo = {
                    inputTokens: u.promptTokenCount ?? 0,
                    outputTokens: u.candidatesTokenCount ?? 0,
                    reasoningTokens: u.thoughtsTokenCount,
                    cachedTokens: u.cachedContentTokenCount,
                    totalTokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0),
                    estimatedCost: "unknown",
                };
                usageInfo.estimatedCost = estimateCost(usageInfo, spec);
                usage = usageInfo;
            }
        }

        // Close any open function calls.
        const order = [...functionCalls.keys()];
        for (let i = 0; i < order.length; i++) {
            yield { type: "tool_call_end", index: i };
        }

        yield { type: "finish", stopReason, usage };
    }

    async chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse> {
        return collectResponse(this.stream(context, signal));
    }

    async healthCheck(): Promise<HealthCheckResult> {
        const started = Date.now();
        try {
            const res = await fetchWithWatchdog(
                "https://generativelanguage.googleapis.com/v1beta/models",
                { method: "GET", headers: await this.resolveAuthHeaders() },
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
        return null; // model list requires listing from the API — static catalog + user config
    }
}

function retryAfterMsMs(res: Response): number | undefined {
    const value = res.headers.get("retry-after");
    if (!value) return undefined;
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
    return undefined;
}
