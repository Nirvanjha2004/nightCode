// llm-client/models.ts — static model catalog + model registry.
//
// Models are NOT hardcoded in the agent core. Each provider ships a static
// catalog (capabilities, context window, pricing where known); providers with
// a model-list endpoint may supplement it with dynamic discovery. Pricing is
// only ever included when we are confident of it — otherwise cost is "unknown".

import type { ModelSpec } from "./types";

type ModelOverrides = Partial<Omit<ModelSpec, "id" | "name" | "provider">> & {
    id?: string;
    name?: string;
};

function m(id: string, provider: string, overrides: ModelOverrides = {}): ModelSpec {
    const o = overrides;
    return {
        id: o.id ?? id,
        name: o.name ?? o.id ?? id,
        provider,
        contextWindow: o.contextWindow ?? 128_000,
        maxOutputTokens: o.maxOutputTokens ?? 8192,
        inputModalities: o.inputModalities ?? ["text"],
        outputModalities: o.outputModalities ?? ["text"],
        reasoning: o.reasoning ?? false,
        reasoningEffort: o.reasoningEffort ?? false,
        toolCalling: o.toolCalling ?? true,
        vision: o.vision ?? false,
        structuredOutput: o.structuredOutput ?? false,
        parallelToolCalls: o.parallelToolCalls ?? true,
        developerMessages: o.developerMessages ?? false,
        pricing: o.pricing,
    };
}

// Capabilities for models NOT in the catalog — a conservative default so an
// unknown model still works (no fancy params, plain tool calling).
export function defaultModelSpec(provider: string, id: string): ModelSpec {
    return m(id, provider, {
        contextWindow: 128_000,
        maxOutputTokens: 8192,
        toolCalling: true,
        reasoning: false,
        vision: false,
    });
}

// ── OpenAI ────────────────────────────────────────────────────────────────
const OPENAI: ModelSpec[] = [
    m("gpt-4o", "openai", {
        contextWindow: 128_000, maxOutputTokens: 16_384, vision: true, structuredOutput: true,
        pricing: { input: 2.5, output: 10, cachedInput: 1.25 },
    }),
    m("gpt-4o-mini", "openai", {
        contextWindow: 128_000, maxOutputTokens: 16_384, vision: true, structuredOutput: true,
        pricing: { input: 0.15, output: 0.6, cachedInput: 0.075 },
    }),
    m("gpt-4.1", "openai", {
        contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true, structuredOutput: true,
        developerMessages: true,
        pricing: { input: 2, output: 8, cachedInput: 0.5 },
    }),
    m("gpt-4.1-mini", "openai", {
        contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true, structuredOutput: true,
        developerMessages: true,
        pricing: { input: 0.4, output: 1.6, cachedInput: 0.1 },
    }),
    m("gpt-4.1-nano", "openai", {
        contextWindow: 1_047_576, maxOutputTokens: 32_768, developerMessages: true,
        pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 },
    }),
    m("o3", "openai", {
        contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true, reasoningEffort: true,
        developerMessages: true,
        pricing: { input: 2, output: 8, cachedInput: 0.5 },
    }),
    m("o3-mini", "openai", {
        contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true, reasoningEffort: true,
        developerMessages: true,
        pricing: { input: 1.1, output: 4.4, cachedInput: 0.275 },
    }),
    m("o4-mini", "openai", {
        contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true, reasoningEffort: true,
        developerMessages: true,
        pricing: { input: 1.1, output: 4.4, cachedInput: 0.275 },
    }),
    m("gpt-5", "openai", {
        contextWindow: 272_000, maxOutputTokens: 100_000, reasoning: true, reasoningEffort: true,
        vision: true, developerMessages: true,
        pricing: { input: 1.25, output: 10, cachedInput: 0.125 },
    }),
    m("gpt-5-mini", "openai", {
        contextWindow: 272_000, maxOutputTokens: 100_000, reasoning: true, reasoningEffort: true,
        vision: true, developerMessages: true,
        pricing: { input: 0.25, output: 2, cachedInput: 0.025 },
    }),
];

// ── Anthropic ─────────────────────────────────────────────────────────────
const ANTHROPIC: ModelSpec[] = [
    m("claude-sonnet-4-5", "anthropic", {
        contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true, vision: true,
        pricing: { input: 3, output: 15, cachedInput: 0.3 },
    }),
    m("claude-opus-4-1", "anthropic", {
        contextWindow: 200_000, maxOutputTokens: 32_000, reasoning: true, vision: true,
        pricing: { input: 15, output: 75, cachedInput: 1.5 },
    }),
    m("claude-haiku-4-5", "anthropic", {
        contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true, vision: true,
        pricing: { input: 1, output: 5, cachedInput: 0.1 },
    }),
    m("claude-3-5-sonnet-latest", "anthropic", {
        contextWindow: 200_000, maxOutputTokens: 8192, vision: true,
        pricing: { input: 3, output: 15, cachedInput: 0.3 },
    }),
    m("claude-3-7-sonnet-latest", "anthropic", {
        contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true, vision: true,
        pricing: { input: 3, output: 15, cachedInput: 0.3 },
    }),
];

// ── Google Gemini ─────────────────────────────────────────────────────────
const GOOGLE: ModelSpec[] = [
    m("gemini-2.5-pro", "google", {
        contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true,
        structuredOutput: true,
        pricing: { input: 1.25, output: 10, cachedInput: 0.3125 },
    }),
    m("gemini-2.5-flash", "google", {
        contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true,
        structuredOutput: true,
        pricing: { input: 0.3, output: 2.5, cachedInput: 0.075 },
    }),
    m("gemini-2.5-flash-lite", "google", {
        contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true,
        structuredOutput: true,
        pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 },
    }),
    m("gemini-2.0-flash", "google", {
        contextWindow: 1_048_576, maxOutputTokens: 8192, vision: true, structuredOutput: true,
        pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 },
    }),
];

// ── Groq (default provider — the models NightCode shipped with) ──────────
const GROQ: ModelSpec[] = [
    m("qwen/qwen3.6-27b", "groq", { contextWindow: 131_072, maxOutputTokens: 12_288 }),
    m("llama-3.1-8b-instant", "groq", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("llama-3.3-70b-versatile", "groq", { contextWindow: 131_072, maxOutputTokens: 32_768 }),
    m("deepseek-r1-distill-llama-70b", "groq", { contextWindow: 131_072, reasoning: true, maxOutputTokens: 16_384 }),
    m("meta-llama/llama-4-scout-17b-16e-instruct", "groq", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("openai/gpt-oss-120b", "groq", { contextWindow: 131_072, maxOutputTokens: 32_768 }),
];

// ── DeepSeek ──────────────────────────────────────────────────────────────
const DEEPSEEK: ModelSpec[] = [
    m("deepseek-chat", "deepseek", {
        contextWindow: 131_072, maxOutputTokens: 8192,
        pricing: { input: 0.27, output: 1.1, cachedInput: 0.07 },
    }),
    m("deepseek-reasoner", "deepseek", {
        contextWindow: 131_072, maxOutputTokens: 8192, reasoning: true,
        pricing: { input: 0.55, output: 2.19, cachedInput: 0.14 },
    }),
];

// ── Mistral ───────────────────────────────────────────────────────────────
const MISTRAL: ModelSpec[] = [
    m("mistral-large-latest", "mistral", {
        contextWindow: 131_072, maxOutputTokens: 8192, vision: true,
        pricing: { input: 2, output: 6 },
    }),
    m("mistral-small-latest", "mistral", {
        contextWindow: 131_072, maxOutputTokens: 8192,
        pricing: { input: 0.1, output: 0.3 },
    }),
    m("codestral-latest", "mistral", {
        contextWindow: 131_072, maxOutputTokens: 8192,
        pricing: { input: 0.3, output: 0.9 },
    }),
];

// ── xAI ───────────────────────────────────────────────────────────────────
const XAI: ModelSpec[] = [
    m("grok-3", "xai", {
        contextWindow: 131_072, maxOutputTokens: 16_384, reasoning: true, reasoningEffort: true,
        vision: true,
        pricing: { input: 3, output: 15 },
    }),
    m("grok-3-mini", "xai", {
        contextWindow: 131_072, maxOutputTokens: 16_384, reasoning: true, reasoningEffort: true,
        pricing: { input: 0.3, output: 0.5 },
    }),
    m("grok-3-fast", "xai", {
        contextWindow: 131_072, maxOutputTokens: 16_384, reasoning: true, reasoningEffort: true,
        pricing: { input: 0.3, output: 0.5 },
    }),
];

// ── Cerebras / Together / Fireworks / NVIDIA / OpenRouter (curated) ──────
const CEREBRAS: ModelSpec[] = [
    m("llama-3.3-70b", "cerebras", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("llama-3.1-8b", "cerebras", { contextWindow: 131_072, maxOutputTokens: 8192 }),
];

const TOGETHER: ModelSpec[] = [
    m("meta-llama/Llama-3.3-70B-Instruct-Turbo", "together", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("deepseek-ai/DeepSeek-V3", "together", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("Qwen/Qwen2.5-Coder-32B-Instruct", "together", { contextWindow: 131_072, maxOutputTokens: 8192 }),
];

const FIREWORKS: ModelSpec[] = [
    m("accounts/fireworks/models/deepseek-v3", "fireworks", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("accounts/fireworks/models/llama-v3p3-70b-instruct", "fireworks", { contextWindow: 131_072, maxOutputTokens: 8192 }),
];

const NVIDIA: ModelSpec[] = [
    m("nvidia/llama-3.3-nemotron-super-49b-v1", "nvidia", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("meta/llama-3.1-405b-instruct", "nvidia", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("deepseek-ai/deepseek-r1", "nvidia", { contextWindow: 131_072, maxOutputTokens: 8192, reasoning: true }),
];

const OPENROUTER: ModelSpec[] = [
    m("anthropic/claude-sonnet-4.5", "openrouter", { contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true, vision: true }),
    m("openai/gpt-5", "openrouter", { contextWindow: 272_000, maxOutputTokens: 100_000, reasoning: true, reasoningEffort: true, vision: true }),
    m("openai/gpt-4.1", "openrouter", { contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true }),
    m("google/gemini-2.5-pro", "openrouter", { contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true }),
];

// ── Local / OpenAI-compatible (no key required) ──────────────────────────
const OLLAMA: ModelSpec[] = [
    m("llama3.3", "ollama", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("qwen2.5-coder", "ollama", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("deepseek-r1", "ollama", { contextWindow: 131_072, maxOutputTokens: 8192, reasoning: true }),
    m("mistral", "ollama", { contextWindow: 32_768, maxOutputTokens: 8192 }),
];

const VLLM: ModelSpec[] = [
    m("Qwen/Qwen2.5-Coder-32B-Instruct", "vllm", { contextWindow: 131_072, maxOutputTokens: 8192 }),
];

const MINIMAX: ModelSpec[] = [
    m("MiniMax-Text-01", "minimax", { contextWindow: 1_000_000, maxOutputTokens: 8192, vision: false }),
];

const KIMI: ModelSpec[] = [
    m("kimi-latest", "kimi", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("kimi-k2", "kimi", { contextWindow: 131_072, maxOutputTokens: 8192, reasoning: true }),
];

const HUGGINGFACE: ModelSpec[] = [
    m("Qwen/Qwen2.5-Coder-32B-Instruct", "huggingface", { contextWindow: 131_072, maxOutputTokens: 8192 }),
    m("deepseek-ai/DeepSeek-V3", "huggingface", { contextWindow: 131_072, maxOutputTokens: 8192 }),
];

/** Static catalog: providerId → ModelSpec[]. Unknown providers start empty. */
export const MODEL_CATALOG: Record<string, ModelSpec[]> = {
    openai: OPENAI,
    anthropic: ANTHROPIC,
    google: GOOGLE,
    groq: GROQ,
    deepseek: DEEPSEEK,
    mistral: MISTRAL,
    xai: XAI,
    cerebras: CEREBRAS,
    together: TOGETHER,
    fireworks: FIREWORKS,
    nvidia: NVIDIA,
    openrouter: OPENROUTER,
    ollama: OLLAMA,
    vllm: VLLM,
    minimax: MINIMAX,
    kimi: KIMI,
    huggingface: HUGGINGFACE,
};

/** Build a ModelSpec from a custom-provider model entry. */
export function modelSpecFromCustom(
    providerId: string,
    entry: { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number; reasoning?: boolean; reasoningEffort?: boolean; toolCalling?: boolean; vision?: boolean; structuredOutput?: boolean; parallelToolCalls?: boolean; developerMessages?: boolean }
): ModelSpec {
    return m(entry.id, providerId, {
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        reasoning: entry.reasoning,
        reasoningEffort: entry.reasoningEffort,
        toolCalling: entry.toolCalling,
        vision: entry.vision,
        structuredOutput: entry.structuredOutput,
        parallelToolCalls: entry.parallelToolCalls,
        developerMessages: entry.developerMessages,
    });
}

/** Apply per-model overrides (id → partial spec) to a catalog. */
export function withModelOverrides(
    specs: ModelSpec[],
    overrides?: Record<string, Partial<ModelSpec>>
): ModelSpec[] {
    if (!overrides) return specs;
    return specs.map((s) => {
        const o = overrides[s.id];
        return o ? { ...s, ...o, id: s.id, provider: s.provider } : s;
    });
}

// ── Registry ──────────────────────────────────────────────────────────────

export class ModelRegistry {
    private models = new Map<string, ModelSpec>();

    /** Register (or replace) a model by `${providerId}/${modelId}`. */
    set(model: ModelSpec): void {
        this.models.set(`${model.provider}/${model.id}`, model);
    }

    get(providerId: string, modelId: string): ModelSpec | undefined {
        return this.models.get(`${providerId}/${modelId}`);
    }

    /** Look up with a fallback spec so an unknown model still has sane defaults. */
    getOrFallback(providerId: string, modelId: string): ModelSpec {
        return this.get(providerId, modelId) ?? defaultModelSpec(providerId, modelId);
    }

    list(providerId?: string): ModelSpec[] {
        const all = [...this.models.values()];
        return providerId ? all.filter((s) => s.provider === providerId) : all;
    }
}
