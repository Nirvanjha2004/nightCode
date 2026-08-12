// llm-client/transports/bedrock.ts — Amazon Bedrock.
//
// Uses the Converse API (native tool calling, streaming) with SigV4-signed
// requests and AWS event-stream response parsing. Credentials come from
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (optional)
// and AWS_REGION — nothing cloud-specific leaks into the agent core.

import type { HealthCheckResult, LLMEvent, LLMProvider, LLMResponse, ModelSpec, ProviderConfig, UsageInfo } from "../types";
import type { ContextType } from "../../agent/types";
import { classifyHttpError, withRetryStream } from "../errors";
import { collectResponse, estimateCost } from "../stream";
import { fetchWithWatchdog, bodyText } from "./http";
import { signRequest, type AwsCredentials } from "./sigv4";
import { parseAwsEventStream, framePayloadJson } from "./aws-event-stream";
import { withModelOverrides } from "../models";
import { logger } from "../../logger";

const DEFAULT_REGION = "us-east-1";

type ConverseContent =
    | { text: string }
    | { toolResult: { toolUseId: string; content: Array<{ text: string }> } }
    | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } };

export class BedrockProvider implements LLMProvider {
    readonly providerId: string;
    readonly displayName: string;
    readonly config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.config = config;
        this.providerId = config.providerId;
        this.displayName = config.displayName;
    }

    private credentials(): AwsCredentials | undefined {
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        if (!accessKeyId || !secretAccessKey) return undefined;
        return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
    }

    private region(): string {
        return this.config.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
    }

    private endpoint(model: string): string {
        return `https://bedrock-runtime.${this.region()}.amazonaws.com/model/${encodeURIComponent(model)}/converse-stream`;
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
            reasoning: false,
            reasoningEffort: false,
            toolCalling: true,
            vision: false,
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
        return this.config.summarizerModel ?? "amazon.nova-micro-v1:0";
    }

    subagentModel(): string {
        return this.config.subagentModel ?? "amazon.nova-micro-v1:0";
    }

    private buildSystem(context: ContextType): string {
        const summary = context.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");
        return summary ? `${context.systemPrompt}\n\n${summary}` : context.systemPrompt;
    }

    private buildMessages(context: ContextType): Array<{ role: "user" | "assistant"; content: ConverseContent[] }> {
        const out: Array<{ role: "user" | "assistant"; content: ConverseContent[] }> = [];
        const push = (role: "user" | "assistant", content: ConverseContent[]) => {
            const last = out[out.length - 1];
            if (last && last.role === role) {
                last.content.push(...content);
            } else {
                out.push({ role, content });
            }
        };

        for (const message of context.messages) {
            if (message.role === "system") continue;
            if (message.role === "tool") {
                push("user", [{ toolResult: { toolUseId: message.toolCallId ?? "", content: [{ text: message.content }] } }]);
                continue;
            }
            if (message.role === "assistant" && message.toolCalls?.length) {
                const content: ConverseContent[] = [];
                if (message.content) content.push({ text: message.content });
                for (const tc of message.toolCalls) {
                    content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.args } });
                }
                push("assistant", content);
                continue;
            }
            push(message.role === "assistant" ? "assistant" : "user", [{ text: message.content }]);
        }
        return out;
    }

    async *stream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        yield* withRetryStream(
            () => this.rawStream(context, signal),
            {
                maxRetries: 1,
                onRetry: (err, attempt, delay) =>
                    logger.warn(`[bedrock] retry ${attempt} after ${Math.round(delay)}ms: ${(err as Error).message}`),
            },
            signal
        );
    }

    private async *rawStream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        const spec = this.getModel(context.model);
        const creds = this.credentials();
        if (!creds) {
            throw new Error(
                "Bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (optionally AWS_SESSION_TOKEN and AWS_REGION)."
            );
        }

        const body: Record<string, unknown> = {
            modelId: context.model,
            system: [{ text: this.buildSystem(context) }],
            messages: this.buildMessages(context),
            inferenceConfig: { temperature: 0.1, maxTokens: spec.maxOutputTokens },
            ...this.config.requestOverrides,
        };
        if (context.tools.length > 0 && spec.toolCalling) {
            body.toolConfig = {
                tools: context.tools.map((t) => ({
                    toolSpec: { name: t.function.name, description: t.function.description, inputSchema: t.function.parameters },
                })),
            };
        }

        const url = this.endpoint(context.model);
        const bodyString = JSON.stringify(body);
        const signed = signRequest({
            method: "POST",
            url,
            headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
            body: bodyString,
            service: "bedrock",
            region: this.region(),
            credentials: creds,
        });

        const res = await fetchWithWatchdog(
            url,
            {
                method: "POST",
                headers: { ...signed, "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
                body: bodyString,
                signal,
            },
            { signal }
        );

        if (!res.ok) {
            const raw = await bodyText(res);
            throw classifyHttpError({ status: res.status, body: raw, provider: this.providerId, model: context.model });
        }

        // ── AWS event-stream → normalized events ─────────────────────
        const toolUses = new Map<number, { id: string; name: string; input: string }>();
        let stopReason: string | undefined;
        let usage: UsageInfo | undefined;

        for await (const frame of parseAwsEventStream(res.body)) {
            if (frame.eventType !== "chunk") continue;
            const json = framePayloadJson(frame);
            if (!json) continue;

            if (json.messageStart) {
                // no-op — role only
            } else if (json.contentBlockStart) {
                const start = json.contentBlockStart as { contentBlockIndex?: number; start?: { toolUse?: { toolUseId?: string; name?: string } } };
                const index = start.contentBlockIndex ?? 0;
                const tu = start.start?.toolUse;
                if (tu) {
                    toolUses.set(index, { id: tu.toolUseId ?? `call_${index}`, name: tu.name ?? "", input: "" });
                    yield { type: "tool_call_start", index, id: tu.toolUseId ?? `call_${index}`, name: tu.name ?? "" };
                }
            } else if (json.contentBlockDelta) {
                const delta = json.contentBlockDelta as { contentBlockIndex?: number; delta?: { text?: string; reasoningContent?: { text?: string }; toolUse?: { toolUseId?: string; name?: string; input?: string } } };
                const index = delta.contentBlockIndex ?? 0;
                const d = delta.delta;
                if (d?.text) {
                    yield { type: "text_delta", text: d.text };
                } else if (d?.reasoningContent?.text) {
                    // Bedrock Converse streams reasoning (Nova / Claude thinking) here.
                    yield { type: "reasoning_delta", text: d.reasoningContent.text };
                } else if (d?.toolUse) {
                    let entry = toolUses.get(index);
                    if (!entry) {
                        entry = { id: d.toolUse.toolUseId ?? `call_${index}`, name: d.toolUse.name ?? "", input: "" };
                        toolUses.set(index, entry);
                        yield { type: "tool_call_start", index, id: entry.id, name: entry.name };
                    }
                    if (d.toolUse.input) {
                        entry.input += d.toolUse.input;
                        yield { type: "tool_call_delta", index, argumentsDelta: d.toolUse.input };
                    }
                }
            } else if (json.contentBlockStop) {
                const index = (json.contentBlockStop as { contentBlockIndex?: number }).contentBlockIndex ?? 0;
                if (toolUses.has(index)) {
                    yield { type: "tool_call_end", index };
                }
            } else if (json.messageStop) {
                stopReason = (json.messageStop as { stopReason?: string }).stopReason;
            } else if (json.metadata) {
                const u = json.metadata as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
                if (u.usage) {
                    const usageInfo: UsageInfo = {
                        inputTokens: u.usage.inputTokens ?? 0,
                        outputTokens: u.usage.outputTokens ?? 0,
                        totalTokens: u.usage.totalTokens ?? (u.usage.inputTokens ?? 0) + (u.usage.outputTokens ?? 0),
                        estimatedCost: "unknown",
                    };
                    usageInfo.estimatedCost = estimateCost(usageInfo, spec);
                    usage = usageInfo;
                }
            }
        }

        yield { type: "finish", stopReason, usage };
    }

    async chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse> {
        return collectResponse(this.stream(context, signal));
    }

    async healthCheck(): Promise<HealthCheckResult> {
        const creds = this.credentials();
        if (!creds) return { ok: false, auth: true, error: "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set" };
        return { ok: true, latencyMs: 0 };
    }

    async discoverModels(): Promise<ModelSpec[] | null> {
        return null; // no public model-list endpoint — static catalog only
    }
}
