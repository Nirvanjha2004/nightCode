// llm-client/auth.ts — credential resolution.
//
// Resolution order (per provider): explicit config apiKey → env var → none.
// CLI/runtime overrides (NIGHTCODE_PROVIDER / NIGHTCODE_MODEL) are handled at
// config load. Keys are never logged and never included in any message.

/** Look up the first environment variable that is set and non-empty. */
export function envFirst(names: string[] | undefined): string | undefined {
    if (!names) return undefined;
    for (const name of names) {
        const value = process.env[name];
        if (value && value.trim().length > 0) return value;
    }
    return undefined;
}

export type ResolvedCredentials = {
    apiKey?: string;
    /** True when no credential could be resolved at all. */
    missing: boolean;
    /** Human-readable hint naming the env var / config key to set. */
    hint: string;
};

/**
 * Resolve credentials for a provider from config + env. Never throws — a
 * provider without credentials reports `missing` and its health check /
 * calls surface a clear AuthenticationError.
 */
export function resolveCredentials(opts: {
    providerId: string;
    apiKey?: string;
    apiKeyEnv?: string[];
    requiresKey: boolean;
}): ResolvedCredentials {
    const fromConfig = opts.apiKey?.trim();
    if (fromConfig) {
        return { apiKey: fromConfig, missing: false, hint: "" };
    }
    const fromEnv = envFirst(opts.apiKeyEnv);
    if (fromEnv) {
        return { apiKey: fromEnv, missing: false, hint: "" };
    }
    if (!opts.requiresKey) {
        return { missing: false, hint: "" };
    }
    const names = (opts.apiKeyEnv ?? []).join(" / ");
    return {
        missing: true,
        hint: `set ${names || "an API key"} in .env or in nightcode.config.json providers.${opts.providerId}.apiKey`,
    };
}
