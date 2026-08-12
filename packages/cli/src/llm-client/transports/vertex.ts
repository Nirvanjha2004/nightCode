// llm-client/transports/vertex.ts — Google Vertex AI (Gemini via Vertex).
//
// Reuses the Gemini transport: same parts/contents wire format, but the
// endpoint is the aiplatform generateContent URL and auth is an OAuth bearer
// token (service-account JWT or GOOGLE_OAUTH_ACCESS_TOKEN) instead of an API
// key. All cloud-specific configuration (project/region) stays here.

import type { HealthCheckResult, ProviderConfig } from "../types";
import { GoogleProvider } from "./google";
import { resolveGoogleAccessToken } from "./google-auth";

export class VertexProvider extends GoogleProvider {
    private readonly project: string;
    private readonly location: string;

    constructor(config: ProviderConfig) {
        super(config, undefined);
        this.project = config.project ?? config.placeholders?.project ?? "YOUR_PROJECT";
        this.location = config.region ?? config.placeholders?.location ?? "us-central1";
    }

    protected override endpoint(model: string): string {
        return `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent`;
    }

    protected override async resolveAuthHeaders(): Promise<Record<string, string>> {
        const token = await resolveGoogleAccessToken();
        if (!token) {
            const err = new Error(
                "Vertex AI requires Google credentials: set GOOGLE_OAUTH_ACCESS_TOKEN, or GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_APPLICATION_CREDENTIALS_JSON."
            );
            (err as { status?: number }).status = 401;
            throw err;
        }
        return { "Content-Type": "application/json", ...this.config.headers, Authorization: `Bearer ${token}` };
    }

    override async healthCheck(): Promise<HealthCheckResult> {
        const started = Date.now();
        try {
            await this.resolveAuthHeaders();
            return { ok: true, latencyMs: Date.now() - started };
        } catch (err) {
            return { ok: false, auth: true, error: err instanceof Error ? err.message : String(err) };
        }
    }
}
