// llm-client/config.ts — NightCode provider configuration.
//
// Sources, in order of precedence (low → high):
//   1. Static defaults (groq + the model NightCode shipped with).
//   2. `nightcode.config.json` at the project root (or NIGHTCODE_CONFIG path).
//   3. Environment overrides NIGHTCODE_PROVIDER / NIGHTCODE_MODEL.
//   4. Per-provider credentials: config apiKey → env var (handled in auth.ts).
//
// Backward compatibility: the legacy top-level fields `provider`, `model`,
// `apiKey`, `baseUrl` keep working and are folded into the provider override.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../paths";
import { logger } from "../logger";

export type CustomModelConfig = {
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    reasoningEffort?: boolean;
    toolCalling?: boolean;
    vision?: boolean;
    structuredOutput?: boolean;
    parallelToolCalls?: boolean;
    developerMessages?: boolean;
};

export type CustomProviderConfig = {
    api: "openai-compatible" | "anthropic" | "google";
    /** Optional — an entry overriding a built-in preset may omit it. */
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    /** False for keyless local/proxy endpoints (default: true). */
    requiresKey?: boolean;
    displayName?: string;
    headers?: Record<string, string>;
    requestOverrides?: Record<string, unknown>;
    models?: CustomModelConfig[];
    summarizerModel?: string;
    subagentModel?: string;
};

export type NightCodeConfig = {
    /** Default provider id. */
    provider: string;
    /** True when the user explicitly chose the provider (config file / env). */
    explicitProvider?: boolean;
    /** Default model id (within the default provider). */
    model: string;
    /** Default reasoning effort for capable models. */
    reasoning: "off" | "low" | "medium" | "high" | "max";
    /** Custom/override providers keyed by id. */
    providers: Record<string, CustomProviderConfig>;
};

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const DEFAULT_PROVIDER = "groq";

function defaultConfig(): NightCodeConfig {
    return {
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        reasoning: "off",
        providers: {},
    };
}

function configPath(): string {
    const override = process.env.NIGHTCODE_CONFIG;
    if (override) return override;
    return join(PROJECT_ROOT, "nightcode.config.json");
}

/** Load and validate the config file; malformed files degrade to defaults. */
export function loadConfig(): NightCodeConfig {
    const cfg = defaultConfig();
    const path = configPath();

    // Note: no early return when the file is missing — the environment
    // overrides below must still run (NIGHTCODE_PROVIDER works without a
    // config file).
    if (!existsSync(path)) return applyEnvOverrides(cfg);

    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

        if (typeof raw.provider === "string" && raw.provider) {
            cfg.provider = raw.provider;
            cfg.explicitProvider = true;
        }
        if (typeof raw.model === "string" && raw.model) cfg.model = raw.model;
        if (
            typeof raw.reasoning === "string" &&
            ["off", "low", "medium", "high", "max"].includes(raw.reasoning)
        ) {
            cfg.reasoning = raw.reasoning as NightCodeConfig["reasoning"];
        }
        if (raw.providers && typeof raw.providers === "object") {
            for (const [id, value] of Object.entries(raw.providers as Record<string, unknown>)) {
                if (!value || typeof value !== "object") continue;
                const p = value as Record<string, unknown>;
                const api = p.api as CustomProviderConfig["api"] | undefined;
                if (api !== "openai-compatible" && api !== "anthropic" && api !== "google") continue;
                const custom: CustomProviderConfig = {
                    api,
                    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
                    apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined,
                    apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : undefined,
                    requiresKey: typeof p.requiresKey === "boolean" ? p.requiresKey : undefined,
                    displayName: typeof p.displayName === "string" ? p.displayName : undefined,
                    headers:
                        p.headers && typeof p.headers === "object"
                            ? (p.headers as Record<string, string>)
                            : undefined,
                    requestOverrides:
                        p.requestOverrides && typeof p.requestOverrides === "object"
                            ? (p.requestOverrides as Record<string, unknown>)
                            : undefined,
                    summarizerModel: typeof p.summarizerModel === "string" ? p.summarizerModel : undefined,
                    subagentModel: typeof p.subagentModel === "string" ? p.subagentModel : undefined,
                    models: Array.isArray(p.models)
                        ? (p.models as CustomModelConfig[])
                        : undefined,
                };
                cfg.providers[id] = custom;
            }
        }

        // ── Legacy backward-compatible fields ──────────────────────────
        // The old single-provider shape ({ provider, model, apiKey, baseUrl })
        // folds into a provider override for the selected provider.
        const legacyKey = typeof raw.apiKey === "string" && raw.apiKey ? raw.apiKey : undefined;
        const legacyBase = typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : undefined;
        if (legacyKey || legacyBase) {
            const existing = cfg.providers[cfg.provider];
            const api = existing?.api ?? "openai-compatible";
            cfg.providers[cfg.provider] = {
                api,
                // No `?? ""` here: an absent legacy baseUrl must leave the
                // built-in preset's URL intact (the merge in index.ts keeps the
                // preset baseUrl when the custom entry doesn't set one).
                baseUrl: legacyBase ?? existing?.baseUrl,
                apiKey: legacyKey ?? existing?.apiKey,
                apiKeyEnv: existing?.apiKeyEnv,
                requiresKey: existing?.requiresKey,
                displayName: existing?.displayName,
                models: existing?.models,
                headers: existing?.headers,
                requestOverrides: existing?.requestOverrides,
                summarizerModel: existing?.summarizerModel,
                subagentModel: existing?.subagentModel,
            };
            logger.info(
                `[Config] Legacy provider fields applied to "${cfg.provider}" (apiKey/baseUrl)` +
                    (legacyKey ? " — API key moved out of source, good" : "")
            );
        }
    } catch (err) {
        logger.error(
            `[Config] Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)} — using defaults`
        );
    }

    return applyEnvOverrides(cfg);
}

/** Environment overrides (highest precedence for provider/model). */
function applyEnvOverrides(cfg: NightCodeConfig): NightCodeConfig {
    if (process.env.NIGHTCODE_PROVIDER?.trim()) {
        cfg.provider = process.env.NIGHTCODE_PROVIDER.trim();
        cfg.explicitProvider = true;
    }
    if (process.env.NIGHTCODE_MODEL?.trim()) cfg.model = process.env.NIGHTCODE_MODEL.trim();
    return cfg;
}
