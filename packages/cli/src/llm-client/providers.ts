// llm-client/providers.ts — built-in provider presets.
//
// Every entry is data: an api family, a base URL, env var names, a static
// model catalog, and capability flags. None of this reaches the agent core —
// it configures the transports, nothing more. Adding a provider = adding a
// preset (or a custom entry in nightcode.config.json).

import type { ProviderConfig } from "./types";
import type { ModelSpec } from "./types";
import { MODEL_CATALOG, defaultModelSpec } from "./models";

/** Safe catalog access (noUncheckedIndexedAccess). */
function catalog(id: string): ModelSpec[] {
    return MODEL_CATALOG[id] ?? [];
}

export type ProviderPreset = ProviderConfig & { requiresKey: boolean };

const OAI = "openai-compatible" as const;

export function buildProviderPresets(): ProviderPreset[] {
    return [
        // ── Major hosted providers ──────────────────────────────────────
        {
            providerId: "openai",
            displayName: "OpenAI",
            api: OAI,
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: ["OPENAI_API_KEY"],
            models: catalog("openai"),
            requiresKey: true,
        },
        {
            providerId: "anthropic",
            displayName: "Anthropic",
            api: "anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            apiKeyEnv: ["ANTHROPIC_API_KEY"],
            models: catalog("anthropic"),
            requiresKey: true,
        },
        {
            providerId: "google",
            displayName: "Google Gemini",
            api: "google",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKeyEnv: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
            models: catalog("google"),
            requiresKey: true,
        },

        // ── Groq — the provider NightCode shipped with ─────────────────
        {
            providerId: "groq",
            displayName: "Groq",
            api: OAI,
            baseUrl: "https://api.groq.com/openai/v1",
            apiKeyEnv: ["GROQ_API_KEY"],
            models: catalog("groq"),
            requiresKey: true,
            summarizerModel: "llama-3.1-8b-instant",
            subagentModel: "llama-3.1-8b-instant",
            // Preserves the original GroqClient's malformed-tool-call repair.
            repairToolCalls: true,
        },

        // ── OpenAI-compatible hosts ────────────────────────────────────
        {
            providerId: "deepseek",
            displayName: "DeepSeek",
            api: OAI,
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyEnv: ["DEEPSEEK_API_KEY"],
            models: catalog("deepseek"),
            requiresKey: true,
        },
        {
            providerId: "together",
            displayName: "Together AI",
            api: OAI,
            baseUrl: "https://api.together.xyz/v1",
            apiKeyEnv: ["TOGETHER_API_KEY"],
            models: catalog("together"),
            requiresKey: true,
        },
        {
            providerId: "fireworks",
            displayName: "Fireworks AI",
            api: OAI,
            baseUrl: "https://api.fireworks.ai/inference/v1",
            apiKeyEnv: ["FIREWORKS_API_KEY"],
            models: catalog("fireworks"),
            requiresKey: true,
        },
        {
            providerId: "openrouter",
            displayName: "OpenRouter",
            api: OAI,
            baseUrl: "https://openrouter.ai/api/v1",
            apiKeyEnv: ["OPENROUTER_API_KEY"],
            models: catalog("openrouter"),
            requiresKey: true,
        },
        {
            providerId: "cerebras",
            displayName: "Cerebras",
            api: OAI,
            baseUrl: "https://api.cerebras.ai/v1",
            apiKeyEnv: ["CEREBRAS_API_KEY"],
            models: catalog("cerebras"),
            requiresKey: true,
        },
        {
            providerId: "mistral",
            displayName: "Mistral",
            api: OAI,
            baseUrl: "https://api.mistral.ai/v1",
            apiKeyEnv: ["MISTRAL_API_KEY"],
            models: catalog("mistral"),
            requiresKey: true,
        },
        {
            providerId: "xai",
            displayName: "xAI (Grok)",
            api: OAI,
            baseUrl: "https://api.x.ai/v1",
            apiKeyEnv: ["XAI_API_KEY", "GROK_API_KEY"],
            models: catalog("xai"),
            requiresKey: true,
        },
        {
            providerId: "nvidia",
            displayName: "NVIDIA NIM",
            api: OAI,
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKeyEnv: ["NVIDIA_API_KEY"],
            models: catalog("nvidia"),
            requiresKey: true,
        },
        {
            providerId: "zai",
            displayName: "ZAI (01.AI)",
            api: OAI,
            baseUrl: "https://api.01.ai/v1",
            apiKeyEnv: ["ZAI_API_KEY"],
            models: [],
            requiresKey: true,
        },
        {
            providerId: "minimax",
            displayName: "MiniMax",
            api: OAI,
            baseUrl: "https://api.minimax.io/v1",
            apiKeyEnv: ["MINIMAX_API_KEY"],
            models: catalog("minimax"),
            requiresKey: true,
        },
        {
            providerId: "kimi",
            displayName: "Kimi (Moonshot)",
            api: OAI,
            baseUrl: "https://api.moonshot.cn/v1",
            apiKeyEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
            models: catalog("kimi"),
            requiresKey: true,
        },
        {
            providerId: "opencode-zen",
            displayName: "OpenCode Zen",
            api: OAI,
            baseUrl: "https://api.opencode.ai/zen/v1",
            apiKeyEnv: ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"],
            models: [],
            requiresKey: true,
        },
        {
            providerId: "opencode-go",
            displayName: "OpenCode Go",
            api: OAI,
            baseUrl: "https://api.opencode.ai/go/v1",
            apiKeyEnv: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
            models: [],
            requiresKey: true,
        },
        {
            providerId: "huggingface",
            displayName: "Hugging Face",
            api: OAI,
            baseUrl: "https://router.huggingface.co/v1",
            apiKeyEnv: ["HF_API_KEY", "HUGGINGFACE_API_KEY"],
            models: catalog("huggingface"),
            requiresKey: true,
        },
        {
            providerId: "vercel-gateway",
            displayName: "Vercel AI Gateway",
            api: OAI,
            baseUrl: "https://gateway.vercel.ai/v1",
            apiKeyEnv: ["AI_GATEWAY_TOKEN"],
            models: [],
            requiresKey: true,
        },

        // ── Cloudflare ─────────────────────────────────────────────────
        {
            providerId: "cloudflare-gateway",
            displayName: "Cloudflare AI Gateway",
            api: OAI,
            baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_slug}/openai",
            apiKeyEnv: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
            placeholders: {
                account_id: process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? "",
                gateway_slug: process.env.CF_GATEWAY_SLUG ?? "",
            },
            models: [],
            requiresKey: true,
        },
        {
            providerId: "cloudflare-workers",
            displayName: "Cloudflare Workers AI",
            api: OAI,
            baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
            apiKeyEnv: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
            placeholders: {
                account_id: process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? "",
            },
            models: [],
            requiresKey: true,
        },

        // ── Local / self-hosted (no API key) ───────────────────────────
        {
            providerId: "ollama",
            displayName: "Ollama (local)",
            api: OAI,
            baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
            models: catalog("ollama"),
            requiresKey: false,
            discoveryApi: "ollama-tags",
        },
        {
            providerId: "llama-cpp",
            displayName: "llama.cpp (local)",
            api: OAI,
            baseUrl: process.env.LLAMACPP_BASE_URL ?? "http://localhost:8080/v1",
            models: [],
            requiresKey: false,
            discoveryApi: "openai-models",
        },
        {
            providerId: "lmstudio",
            displayName: "LM Studio (local)",
            api: OAI,
            baseUrl: process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1",
            models: [],
            requiresKey: false,
            discoveryApi: "openai-models",
        },
        {
            providerId: "vllm",
            displayName: "vLLM (local)",
            api: OAI,
            baseUrl: process.env.VLLM_BASE_URL ?? "http://localhost:8000/v1",
            models: catalog("vllm"),
            requiresKey: false,
            discoveryApi: "openai-models",
        },

        // ── Cloud platform providers ───────────────────────────────────
        {
            providerId: "azure",
            displayName: "Azure OpenAI",
            api: "azure",
            apiKeyEnv: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY"],
            azure: {
                resource: process.env.AZURE_OPENAI_RESOURCE ?? "",
                deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "",
                apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-06-01",
            },
            models: catalog("openai"),
            requiresKey: true,
        },
        {
            providerId: "vertex",
            displayName: "Google Vertex AI",
            api: "vertex",
            project: process.env.GOOGLE_CLOUD_PROJECT ?? "",
            region: process.env.GOOGLE_CLOUD_REGION ?? "us-central1",
            models: catalog("google"),
            requiresKey: false, // auth via ADC / access token, checked at call time
        },
        {
            providerId: "bedrock",
            displayName: "Amazon Bedrock",
            api: "bedrock",
            region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
            // Catalog lookup with a safe fallback — never spread undefined if a
            // catalog id is renamed (that would silently zero all capabilities).
            models: [
                {
                    ...(catalog("anthropic").find((m) => m.id === "claude-sonnet-4-5") ??
                        defaultModelSpec("bedrock", "anthropic.claude-sonnet-4-5-v2:0")),
                    id: "anthropic.claude-sonnet-4-5-v2:0",
                },
                {
                    ...(catalog("anthropic").find((m) => m.id === "claude-haiku-4-5") ??
                        defaultModelSpec("bedrock", "anthropic.claude-haiku-4-5-v1:0")),
                    id: "anthropic.claude-haiku-4-5-v1:0",
                },
            ],
            requiresKey: false, // checked at call time via AWS env vars
        },

        // ── Custom (configured in nightcode.config.json) ───────────────
        {
            providerId: "custom",
            displayName: "Custom (config)",
            api: OAI,
            baseUrl: "",
            models: [],
            requiresKey: false,
        },
    ];
}

/**
 * Priority order used to pick a default provider when none is configured.
 * Only key-requiring providers appear here: local providers (ollama etc.)
 * work without credentials, so silently selecting one when no key is set
 * would hide a misconfiguration behind connection-refused errors. Choosing
 * a local provider is always explicit (config or NIGHTCODE_PROVIDER).
 */
export const PROVIDER_PRIORITY = [
    "groq",
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "mistral",
    "xai",
    "together",
    "fireworks",
    "openrouter",
    "cerebras",
    "nvidia",
] as const;
