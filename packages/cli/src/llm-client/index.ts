// llm-client/index.ts — builds the provider system from configuration.
//
//   loadConfig() → buildProviderSystem(config) → { registry, router, status }
//
// Custom providers from nightcode.config.json are registered here without any
// NightCode source change. The active provider is the configured one (or the
// first provider in PROVIDER_PRIORITY that has credentials).

import { loadConfig, type CustomProviderConfig, type NightCodeConfig } from "./config";
import { resolveCredentials } from "./auth";
import { buildProviderPresets, PROVIDER_PRIORITY, type ProviderPreset } from "./providers";
import { ProviderRegistry, ProviderRouter } from "./registry";
import { OpenAICompatibleProvider } from "./transports/openai-compatible";
import { AnthropicProvider } from "./transports/anthropic";
import { GoogleProvider } from "./transports/google";
import { AzureProvider } from "./transports/azure";
import { VertexProvider } from "./transports/vertex";
import { BedrockProvider } from "./transports/bedrock";
import { modelSpecFromCustom } from "./models";
import type { LLMProvider, ProviderConfig } from "./types";
import { logger } from "../logger";

export type ProviderAuthStatus = {
    /** true when the provider is usable (no key needed, or a key resolved). */
    ok: boolean;
    hint: string;
};

export type ProviderSystem = {
    registry: ProviderRegistry;
    router: ProviderRouter;
    /** Auth status per provider id (drives the boot guard + selector warnings). */
    status: Record<string, ProviderAuthStatus>;
};

function providerFromPreset(preset: ProviderPreset, apiKey?: string): LLMProvider {
    switch (preset.api) {
        case "anthropic":
            return new AnthropicProvider(preset, apiKey);
        case "google":
            return new GoogleProvider(preset, apiKey);
        case "azure":
            return new AzureProvider(preset, apiKey);
        case "vertex":
            return new VertexProvider(preset);
        case "bedrock":
            return new BedrockProvider(preset);
        default:
            return new OpenAICompatibleProvider(preset, apiKey);
    }
}

/** Convert a custom provider entry from nightcode.config.json into a preset. */
function customProviderToPreset(id: string, custom: CustomProviderConfig): ProviderPreset {
    const api = custom.api;
    const models = (custom.models ?? []).map((m) => modelSpecFromCustom(id, m));
    return {
        providerId: id,
        displayName: custom.displayName ?? id,
        api,
        baseUrl: custom.baseUrl,
        apiKey: custom.apiKey,
        apiKeyEnv: custom.apiKeyEnv ? [custom.apiKeyEnv] : undefined,
        headers: custom.headers,
        requestOverrides: custom.requestOverrides,
        models,
        summarizerModel: custom.summarizerModel,
        subagentModel: custom.subagentModel,
        requiresKey: custom.requiresKey ?? true,
    };
}

export function buildProviderSystem(config: NightCodeConfig): ProviderSystem {
    const registry = new ProviderRegistry();
    const status: Record<string, ProviderAuthStatus> = {};

    const presets = buildProviderPresets();
    const registered = new Map<string, ProviderPreset>();
    for (const preset of presets) registered.set(preset.providerId, preset);

    // Custom providers from config override/append presets. When the id matches
    // a BUILT-IN preset, the custom entry MERGES over it: credentials, baseUrl,
    // headers, extra models apply, but the preset's transport family, model
    // catalog and behavior flags survive. This is what keeps the legacy
    // top-level { apiKey } / { baseUrl } fields working without breaking e.g.
    // Groq's base URL or Anthropic's dedicated adapter.
    for (const [id, custom] of Object.entries(config.providers)) {
        const existing = registered.get(id);
        if (existing) {
            const customPreset = customProviderToPreset(id, custom);
            registered.set(id, {
                ...existing,
                ...customPreset,
                // A custom entry can't silently swap a built-in provider's wire
                // format, nor make a keyless preset (ollama) require a key.
                api: existing.api,
                requiresKey: custom.requiresKey ?? existing.requiresKey,
                baseUrl: customPreset.baseUrl || existing.baseUrl,
                apiKey: customPreset.apiKey ?? existing.apiKey,
                apiKeyEnv: customPreset.apiKeyEnv ?? existing.apiKeyEnv,
                headers: customPreset.headers ?? existing.headers,
                requestOverrides: customPreset.requestOverrides ?? existing.requestOverrides,
                summarizerModel: customPreset.summarizerModel ?? existing.summarizerModel,
                subagentModel: customPreset.subagentModel ?? existing.subagentModel,
                models: customPreset.models.length > 0 ? customPreset.models : existing.models,
            });
        } else {
            registered.set(id, customProviderToPreset(id, custom));
        }
    }

    for (const preset of registered.values()) {
        const creds = resolveCredentials({
            providerId: preset.providerId,
            apiKey: preset.apiKey,
            apiKeyEnv: preset.apiKeyEnv,
            requiresKey: preset.requiresKey,
        });
        const provider = providerFromPreset(preset, creds.apiKey);
        registry.register(provider);
        status[preset.providerId] = {
            ok: !creds.missing,
            hint: creds.hint,
        };
    }

    // Active provider: explicit config wins; otherwise the first priority
    // provider with credentials; otherwise the configured default (the boot
    // guard reports the missing-credentials situation with a clear message).
    let activeId = config.provider;
    if (!config.explicitProvider) {
        const usable = PROVIDER_PRIORITY.find(
            (id) => registry.has(id) && (status[id]?.ok ?? false)
        );
        if (usable) {
            activeId = usable;
            if (usable !== config.provider) {
                logger.info(`[Providers] No credentials for default "${config.provider}" — using "${usable}" (first provider with a key set)`);
            }
        }
    }

    const router = new ProviderRouter(registry, activeId);
    logger.info(
        `[Providers] ${registry.list().length} provider(s) registered; active: ${activeId}` +
            (config.explicitProvider ? " (explicitly configured)" : " (auto-selected)")
    );
    return { registry, router, status };
}

export { loadConfig, ProviderRegistry, ProviderRouter };
export type { NightCodeConfig, CustomProviderConfig };
