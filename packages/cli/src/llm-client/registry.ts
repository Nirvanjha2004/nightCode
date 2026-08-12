// llm-client/registry.ts — provider registry + active-provider router.
//
// The registry is a map of providerId → LLMProvider. The router is the single
// object the agent loop, context builder, and memory system hold: it always
// delegates to the CURRENTLY ACTIVE provider, so switching providers at
// runtime needs no change to any caller.

import { UnknownProviderError } from "./errors";
import type { ContextType } from "../agent/types";
import type { HealthCheckResult, LLMEvent, LLMProvider, LLMResponse, ModelSpec } from "./types";

export class ProviderRegistry {
    private providers = new Map<string, LLMProvider>();

    register(provider: LLMProvider): void {
        this.providers.set(provider.providerId, provider);
    }

    get(providerId: string): LLMProvider | undefined {
        return this.providers.get(providerId);
    }

    list(): LLMProvider[] {
        return [...this.providers.values()];
    }

    has(providerId: string): boolean {
        return this.providers.has(providerId);
    }

    ids(): string[] {
        return [...this.providers.keys()];
    }
}

export class ProviderRouter {
    private activeProviderId: string;

    constructor(
        private registry: ProviderRegistry,
        initialProviderId: string
    ) {
        if (!registry.has(initialProviderId)) {
            throw new UnknownProviderError({
                message: `Unknown provider "${initialProviderId}". Available: ${registry.ids().join(", ") || "(none)"}`,
                provider: initialProviderId,
            });
        }
        this.activeProviderId = initialProviderId;
    }

    get providerId(): string {
        return this.activeProviderId;
    }

    get activeProvider(): LLMProvider {
        const provider = this.registry.get(this.activeProviderId);
        if (!provider) {
            throw new UnknownProviderError({
                message: `Active provider "${this.activeProviderId}" is no longer registered`,
                provider: this.activeProviderId,
            });
        }
        return provider;
    }

    setActiveProvider(providerId: string): void {
        if (!this.registry.has(providerId)) {
            throw new UnknownProviderError({
                message: `Unknown provider "${providerId}". Available: ${this.registry.ids().join(", ")}`,
                provider: providerId,
            });
        }
        this.activeProviderId = providerId;
    }

    // ── Delegation to the active provider ─────────────────────────────
    chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse> {
        return this.activeProvider.chat(context, signal);
    }

    stream(context: ContextType, signal?: AbortSignal): AsyncGenerator<LLMEvent> {
        return this.activeProvider.stream(context, signal);
    }

    listModels(providerId?: string): ModelSpec[] {
        if (providerId) return this.registry.get(providerId)?.listModels() ?? [];
        return this.activeProvider.listModels();
    }

    getModel(modelId: string): ModelSpec {
        return this.activeProvider.getModel(modelId);
    }

    healthCheck(providerId?: string): Promise<HealthCheckResult> {
        const p = providerId ? this.registry.get(providerId) : this.activeProvider;
        return p?.healthCheck() ?? Promise.resolve({ ok: false, error: "unknown provider" });
    }

    discoverModels(providerId?: string): Promise<ModelSpec[] | null> {
        const p = providerId ? this.registry.get(providerId) : this.activeProvider;
        return p?.discoverModels() ?? Promise.resolve(null);
    }

    // ── Context-compression surface (used by ContextBuilder) ──────────
    summarizerModel(): string {
        return this.activeProvider.summarizerModel();
    }

    contextLimit(modelId: string): number {
        return this.activeProvider.getModel(modelId).contextWindow;
    }

    subagentModel(): string {
        return this.activeProvider.subagentModel();
    }
}
