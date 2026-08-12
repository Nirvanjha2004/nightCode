// llm-client/transports/azure.ts — Azure OpenAI.
//
// Azure is OpenAI-compatible but differs in three ways, all isolated here:
//   • URL is https://{resource}.openai.azure.com/openai/deployments/{deployment}
//   • Auth is the `api-key` header (no Bearer)
//   • An `api-version` query param is required on every request
// The deployment id doubles as the wire model id.

import type { HealthCheckResult, ModelSpec } from "../types";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderConfig } from "../types";
import { fetchWithWatchdog } from "./http";
import { withQuery } from "./http";

const DEFAULT_API_VERSION = "2024-06-01";

export class AzureProvider extends OpenAICompatibleProvider {
    private readonly resource: string;
    private readonly deployment: string;
    private readonly apiVersion: string;

    constructor(config: ProviderConfig, apiKey?: string) {
        super(config, apiKey);
        this.resource = config.azure?.resource ?? config.placeholders?.resource ?? "";
        this.deployment = config.azure?.deployment ?? config.placeholders?.deployment ?? "";
        this.apiVersion = config.azure?.apiVersion ?? DEFAULT_API_VERSION;
    }

    protected override baseUrl(): string {
        const resource = this.resource || "YOUR_RESOURCE";
        const deployment = this.deployment || "YOUR_DEPLOYMENT";
        return `https://${resource}.openai.azure.com/openai/deployments/${deployment}`;
    }

    protected override wireModel(_modelId: string): string {
        // Azure ignores the model field; the deployment IS the model.
        return this.deployment || _modelId;
    }

    protected override chatCompletionsUrl(): string {
        return withQuery(super.chatCompletionsUrl(), { "api-version": this.apiVersion });
    }

    protected override headers(): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            ...this.config.headers,
        };
        if (this.apiKey) h["api-key"] = this.apiKey;
        return h;
    }

    override getModel(modelId: string): ModelSpec {
        const base = super.getModel(modelId);
        // mark every azure model as a deployment-backed entry
        return { ...base, name: `${base.name} (deployment: ${this.deployment || modelId})` };
    }

    override async healthCheck(): Promise<HealthCheckResult> {
        const started = Date.now();
        try {
            const res = await fetchWithWatchdog(
                withQuery(
                    `https://${this.resource || "YOUR_RESOURCE"}.openai.azure.com/openai/deployments`,
                    { "api-version": this.apiVersion }
                ),
                { method: "GET", headers: this.headers() },
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
}
