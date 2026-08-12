// llm-client/types.ts — provider-neutral types for the LLM layer.
//
// The agent core speaks ONLY these types. Provider adapters translate their
// own wire formats into them, so the loop never branches on provider id.
import type { ContextType, ToolCall, ToolDefinition } from "../agent/types";
import type { ProviderError } from "./errors";

// ── Tool calling ──────────────────────────────────────────────────────────

/** Neutral tool definition (OpenAI-compatible wire shape). */
export type { ToolDefinition };

// ── Capabilities ──────────────────────────────────────────────────────────

/** Normalized reasoning-effort levels. Adapters translate these per provider. */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

/**
 * What a model can do. The agent adapts requests to these: no reasoning_effort
 * for models without it, no developer-role messages unless supported, etc.
 */
export type Capabilities = {
    streaming: boolean;
    toolCalling: boolean;
    parallelToolCalls: boolean;
    reasoning: boolean;
    /** Model accepts a reasoning-effort parameter (OpenAI-style) vs. fixed/extended thinking. */
    reasoningEffort: boolean;
    vision: boolean;
    structuredOutput: boolean;
    systemMessages: boolean;
    /** Model accepts role:"developer" messages (OpenAI 4.1/o-series style). */
    developerMessages: boolean;
    maxContextTokens: number;
    maxOutputTokens: number;
};

// ── Model registry ────────────────────────────────────────────────────────

export type Modality = "text" | "image" | "audio" | "video";

/** Known per-1M-token pricing in USD. `undefined` → cost is "unknown". */
export type Pricing = {
    input: number;
    output: number;
    /** Optional separate price for cache-read tokens (per 1M). */
    cachedInput?: number;
};

export type ModelSpec = {
    /** Wire model id sent to the provider API. */
    id: string;
    /** Human-friendly name (defaults to id). */
    name: string;
    provider: string;
    contextWindow: number;
    maxOutputTokens: number;
    inputModalities: Modality[];
    outputModalities: Modality[];
    reasoning: boolean;
    reasoningEffort: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    parallelToolCalls: boolean;
    developerMessages: boolean;
    /** USD per 1M tokens; absent → estimatedCost is "unknown". */
    pricing?: Pricing;
};

// ── Usage & cost ──────────────────────────────────────────────────────────

export type UsageInfo = {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    totalTokens: number;
    /** Estimated USD cost for the call; "unknown" when pricing is unavailable. */
    estimatedCost: number | "unknown";
};

// ── Responses ─────────────────────────────────────────────────────────────

/**
 * Neutral, non-streaming response the agent loop consumes. `chat()` on a
 * provider is implemented by consuming its normalized `stream()`.
 */
export type LLMResponse =
    | {
          type: "text";
          content: string;
          reasoning?: string;
          usage?: UsageInfo;
      }
    | {
          type: "tool_calls";
          toolCalls: ToolCall[];
          reasoning?: string;
          usage?: UsageInfo;
      };

// ── Normalized streaming events ───────────────────────────────────────────

/**
 * The single internal event format every provider adapter emits. The agent
 * (and any UI) consumes these — never provider-specific stream shapes.
 */
export type LLMEvent =
    | { type: "text_delta"; text: string }
    | { type: "reasoning_delta"; text: string }
    | { type: "tool_call_start"; index: number; id: string; name: string }
    | { type: "tool_call_delta"; index: number; argumentsDelta: string }
    | { type: "tool_call_end"; index: number }
    | { type: "usage"; usage: UsageInfo }
    | { type: "finish"; stopReason?: string; usage?: UsageInfo }
    | { type: "error"; error: ProviderError };

// ── Provider configuration ────────────────────────────────────────────────

/**
 * Static, provider-specific configuration for one provider instance. Never
 * holds secrets in memory longer than needed and never logs them.
 */
export type ProviderConfig = {
    providerId: string;
    displayName: string;
    /** Which transport family implements this provider. */
    api: "openai-compatible" | "anthropic" | "google" | "azure" | "bedrock" | "vertex";
    /** Base URL for the API (may contain {placeholders} — e.g. azure resource, cloudflare account). */
    baseUrl?: string;
    /** Provider-specific env var names tried in order (first set wins). */
    apiKeyEnv?: string[];
    /** Explicit key from config file (overrides env). */
    apiKey?: string;
    /** Extra HTTP headers, e.g. anthropic-version, HTTP-Referer for OpenRouter. */
    headers?: Record<string, string>;
    /** Extra fields merged into the request body. */
    requestOverrides?: Record<string, unknown>;
    /** Static model catalog; empty → discovery or user-defined models only. */
    models: ModelSpec[];
    /** Cheap model used for context summarization on this provider. */
    summarizerModel?: string;
    /** Cheap model used for subagent sessions on this provider. */
    subagentModel?: string;
    /** Per-model capability overrides (id → partial capability flags). */
    modelOverrides?: Record<string, Partial<ModelSpec>>;
    /** Compatibility flags (defaults sensibly for OpenAI-compatible APIs). */
    flags?: Partial<Capabilities>;
    /** Azure: resource name / deployment id / api-version. */
    azure?: { resource?: string; deployment?: string; apiVersion?: string };
    /** Bedrock: region. */
    region?: string;
    /** Vertex: project id + region. */
    project?: string;
    /** Ollama-style local endpoint where discovery uses GET /api/tags. */
    discoveryApi?: "openai-models" | "ollama-tags";
    /** Groq-style tool-repair retry when the API rejects a malformed tool call. */
    repairToolCalls?: boolean;
    /** Send stream_options.include_usage (harmless on most endpoints). */
    includeStreamUsage?: boolean;
    /** Default reasoning effort for this provider's models. */
    defaultReasoningEffort?: ReasoningEffort;
    /** Placeholder values substituted into baseUrl, e.g. {account_id}. */
    placeholders?: Record<string, string>;
};

export type HealthCheckResult =
    | { ok: true; latencyMs: number }
    | { ok: false; error: string; auth?: boolean };

// ── Provider interface ────────────────────────────────────────────────────

/**
 * A provider adapter. The agent core holds the ProviderRouter, which
 * delegates every call to the currently-active provider — the loop never
 * sees provider-specific code.
 */
export interface LLMProvider {
    providerId: string;
    displayName: string;
    /** Static catalog (+ user-configured overrides). */
    listModels(): ModelSpec[];
    /** Capability-carrying spec for a model id (falls back to defaults). */
    getModel(modelId: string): ModelSpec;
    capabilities(modelId: string): Capabilities;
    /** Non-streaming convenience — consumes the normalized stream. */
    chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse>;
    /** Normalized streaming events. */
    stream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent>;
    healthCheck(): Promise<HealthCheckResult>;
    /** Best-effort dynamic model discovery; null when unavailable. */
    discoverModels(): Promise<ModelSpec[] | null>;
    /** Cheap model for context summarization on this provider. */
    summarizerModel(): string;
    /** Cheap model for subagent sessions on this provider. */
    subagentModel(): string;
}

/** A minimal chat surface — what the agent core needs from the LLM layer. */
export type ChatLLM = {
    chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse>;
    /** Cheap summarizer model for the active provider. */
    summarizerModel(): string;
    /** Context-window limit for a model id (drives compression thresholds). */
    contextLimit(modelId: string): number;
    /** Cheap subagent model for the active provider. */
    subagentModel(): string;
};
