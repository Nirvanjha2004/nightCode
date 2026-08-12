// providers.check.ts — assert-based self-check for the provider system.
// Verifies: preset registration, credential resolution (config > env), custom
// providers from nightcode.config.json (no source change needed), automatic
// active-provider selection, unknown-provider errors, and runtime switching.
// No real API keys — mock providers and mocked env only.
// Run with: bun packages/cli/src/llm-client/providers.check.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviderSystem, loadConfig } from "./index";
import { ProviderRegistry, ProviderRouter } from "./registry";
import { resolveCredentials } from "./auth";
import { MODEL_CATALOG, ModelRegistry, modelSpecFromCustom } from "./models";
import { UnknownProviderError } from "./errors";
import type { ContextType } from "../agent/types";
import type { HealthCheckResult, LLMProvider, LLMResponse, ProviderConfig } from "./types";

const ENV_KEYS = [
    "GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "NIGHTCODE_PROVIDER", "NIGHTCODE_MODEL",
    "OLLAMA_BASE_URL", "JINA_API_KEY",
];

function saveEnv(): Record<string, string | undefined> {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
}

const saved = saveEnv();

function mockProvider(id: string, displayName = id): LLMProvider {
    const p = {
        providerId: id,
        displayName,
        defaultModel: "m1",
        listModels: () => [modelSpecFromCustom(id, { id: "m1" })],
        getModel: (modelId: string) => modelSpecFromCustom(id, { id: modelId }),
        capabilities: () => ({
            streaming: true, toolCalling: true, parallelToolCalls: true, reasoning: false,
            reasoningEffort: false, vision: false, structuredOutput: false,
            systemMessages: true, developerMessages: false, maxContextTokens: 128000, maxOutputTokens: 8192,
        }),
        chat: async (): Promise<LLMResponse> => ({ type: "text", content: `${id}:ok` }),
        stream: async function* () {},
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, latencyMs: 1 }),
        discoverModels: async () => null,
        summarizerModel: () => "m1",
        subagentModel: () => "m1",
    };
    return p;
}

async function main() {
    try {
        // ── preset registration ────────────────────────────────────────
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.GROQ_API_KEY = "gsk-test";
        const system = buildProviderSystem(loadConfig());
        const ids = system.registry.ids();
        for (const expected of [
            "openai", "anthropic", "google", "groq", "deepseek", "mistral", "xai",
            "cerebras", "together", "fireworks", "openrouter", "nvidia", "ollama",
            "lmstudio", "llama-cpp", "vllm", "azure", "vertex", "bedrock",
        ]) {
            assert.ok(ids.includes(expected), `preset "${expected}" registered`);
        }
        assert.equal(system.router.providerId, "groq", "GROQ_API_KEY → groq is the active provider (backward compatible)");
        assert.equal(system.status.groq?.ok, true, "groq authenticated");
        assert.equal(system.status.openai?.ok, false, "openai not authenticated");
        assert.ok((system.status.openai?.hint ?? "").includes("OPENAI_API_KEY"), "missing-key hint names the env var");

        // groq catalog includes the model NightCode shipped with
        const groqModels = system.registry.get("groq")!.listModels();
        assert.ok(groqModels.some((m) => m.id === "llama-3.3-70b-versatile"), "groq catalog keeps llama-3.3-70b-versatile");
        assert.equal(system.registry.get("groq")!.summarizerModel(), "llama-3.1-8b-instant", "groq summarizer model preserved");

        // ── auto-selection priority: openai when only OPENAI_API_KEY set ──
        delete process.env.GROQ_API_KEY;
        process.env.OPENAI_API_KEY = "sk-test";
        const sys2 = buildProviderSystem(loadConfig());
        assert.equal(sys2.router.providerId, "openai", "only OPENAI_API_KEY → openai auto-selected");
        assert.equal(sys2.router.activeProvider.displayName, "OpenAI");

        // ── no keys at all → default groq, boot guard reports it ──────
        delete process.env.OPENAI_API_KEY;
        const sys3 = buildProviderSystem(loadConfig());
        assert.equal(sys3.router.providerId, "groq", "no keys → configured default (groq)");
        assert.equal(sys3.status.groq?.ok, false, "boot guard sees the missing credentials");

        // ── explicit provider beats auto-selection ────────────────────
        delete process.env.GROQ_API_KEY;
        process.env.OPENAI_API_KEY = "sk-test";
        process.env.NIGHTCODE_PROVIDER = "deepseek";
        process.env.DEEPSEEK_API_KEY = "ds-test";
        const sys4 = buildProviderSystem(loadConfig());
        assert.equal(sys4.router.providerId, "deepseek", "NIGHTCODE_PROVIDER wins over auto-selection");

        // ── unknown explicit provider → clear error ───────────────────
        process.env.NIGHTCODE_PROVIDER = "does-not-exist";
        assert.throws(
            () => buildProviderSystem(loadConfig()),
            (err: unknown) => err instanceof UnknownProviderError && /does-not-exist/.test(err.message),
            "unknown provider throws UnknownProviderError with a helpful message"
        );

        // ── custom provider from nightcode.config.json ────────────────
        process.env.NIGHTCODE_PROVIDER = "my-provider";
        process.env.MY_LLM_KEY = "custom-key";
        const dir = mkdtempSync(join(tmpdir(), "providers-check-"));
        const cfgPath = join(dir, "nightcode.config.json");
        writeFileSync(
            cfgPath,
            JSON.stringify({
                provider: "my-provider",
                model: "my-model",
                providers: {
                    "my-provider": {
                        api: "openai-compatible",
                        baseUrl: "http://127.0.0.1:9999/v1",
                        apiKeyEnv: "MY_LLM_KEY",
                        displayName: "My Custom",
                        models: [{ id: "my-model", reasoning: true, contextWindow: 64000 }],
                    },
                },
            })
        );
        const oldPath = process.env.NIGHTCODE_CONFIG;
        process.env.NIGHTCODE_CONFIG = cfgPath;
        const sys5 = buildProviderSystem(loadConfig());
        assert.equal(sys5.router.providerId, "my-provider", "custom provider active");
        const custom = sys5.registry.get("my-provider")!;
        assert.equal(custom.displayName, "My Custom");
        assert.equal(custom.listModels().length, 1);
        const customModel = custom.listModels()[0]!;
        assert.equal(customModel.id, "my-model");
        assert.equal(customModel.reasoning, true, "custom model capability honored");
        assert.equal(customModel.contextWindow, 64000, "custom model context window honored");
        assert.equal(sys5.status["my-provider"]?.ok, true, "custom provider authenticated via its env var");
        if (oldPath === undefined) delete process.env.NIGHTCODE_CONFIG;
        else process.env.NIGHTCODE_CONFIG = oldPath;
        delete process.env.MY_LLM_KEY;

        // ── legacy top-level apiKey must NOT clobber the built-in preset ──
        // The old { provider, model, apiKey, baseUrl } shape folds into a
        // provider override; the merge must preserve the preset's transport
        // family, base URL and behavior flags.
        const dir2 = mkdtempSync(join(tmpdir(), "providers-legacy-"));
        const legacyPath = join(dir2, "nightcode.config.json");
        for (const k of ENV_KEYS) delete process.env[k];
        writeFileSync(
            legacyPath,
            JSON.stringify({ provider: "groq", model: "llama-3.3-70b-versatile", apiKey: "gsk-legacy" })
        );
        const oldPath2 = process.env.NIGHTCODE_CONFIG;
        process.env.NIGHTCODE_CONFIG = legacyPath;
        const sysLegacy = buildProviderSystem(loadConfig());
        assert.equal(sysLegacy.router.providerId, "groq", "legacy config keeps groq active");
        assert.equal(sysLegacy.status.groq?.ok, true, "legacy apiKey authenticates groq");
        const groqCfg = (sysLegacy.registry.get("groq") as unknown as { config: ProviderConfig }).config;
        assert.equal(groqCfg.baseUrl, "https://api.groq.com/openai/v1", "legacy apiKey does not wipe the preset base URL");
        assert.equal(groqCfg.repairToolCalls, true, "legacy apiKey does not wipe repairToolCalls");
        assert.equal(
            sysLegacy.registry.get("groq")!.summarizerModel(),
            "llama-3.1-8b-instant",
            "legacy apiKey does not wipe the summarizer model"
        );
        assert.equal(groqCfg.apiKey, "gsk-legacy", "legacy apiKey applied");

        // legacy apiKey must not swap a dedicated adapter to openai-compatible
        writeFileSync(legacyPath, JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-legacy" }));
        const sysLegacy2 = buildProviderSystem(loadConfig());
        const anthroCfg = (sysLegacy2.registry.get("anthropic") as unknown as { config: ProviderConfig }).config;
        assert.equal(anthroCfg.api, "anthropic", "legacy apiKey keeps the Anthropic adapter");
        assert.equal(anthroCfg.baseUrl, "https://api.anthropic.com/v1", "legacy apiKey keeps the Anthropic base URL");
        if (oldPath2 === undefined) delete process.env.NIGHTCODE_CONFIG;
        else process.env.NIGHTCODE_CONFIG = oldPath2;

        // ── keyless custom provider (local/proxy endpoint) ─────────────
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.NIGHTCODE_PROVIDER = "my-local";
        const dir3 = mkdtempSync(join(tmpdir(), "providers-keyless-"));
        const keylessPath = join(dir3, "nightcode.config.json");
        writeFileSync(
            keylessPath,
            JSON.stringify({
                provider: "my-local",
                providers: {
                    "my-local": {
                        api: "openai-compatible",
                        baseUrl: "http://127.0.0.1:9999/v1",
                        requiresKey: false,
                        models: [{ id: "local-model" }],
                    },
                },
            })
        );
        const oldPath3 = process.env.NIGHTCODE_CONFIG;
        process.env.NIGHTCODE_CONFIG = keylessPath;
        const sysKeyless = buildProviderSystem(loadConfig());
        assert.equal(sysKeyless.router.providerId, "my-local", "keyless custom provider selected");
        assert.equal(sysKeyless.status["my-local"]?.ok, true, "keyless custom provider boots without a key");
        if (oldPath3 === undefined) delete process.env.NIGHTCODE_CONFIG;
        else process.env.NIGHTCODE_CONFIG = oldPath3;

        // ── credential resolution order: config apiKey beats env ──────
        process.env.TEST_KEY_ENV = "from-env";
        const creds = resolveCredentials({
            providerId: "t",
            apiKey: "from-config",
            apiKeyEnv: ["TEST_KEY_ENV"],
            requiresKey: true,
        });
        assert.equal(creds.apiKey, "from-config", "explicit config key wins");
        const creds2 = resolveCredentials({
            providerId: "t",
            apiKeyEnv: ["TEST_KEY_ENV"],
            requiresKey: true,
        });
        assert.equal(creds2.apiKey, "from-env", "env var used when no config key");
        const creds3 = resolveCredentials({ providerId: "t", requiresKey: true });
        assert.equal(creds3.missing, true, "no source → missing");
        delete process.env.TEST_KEY_ENV;

        // ── model registry ────────────────────────────────────────────
        const reg = new ModelRegistry();
        reg.set(modelSpecFromCustom("x", { id: "a" }));
        assert.ok(reg.get("x", "a"), "model registry lookup");
        assert.equal(reg.get("x", "nope"), undefined, "unknown model → undefined");
        assert.ok(reg.getOrFallback("x", "nope"), "fallback spec for unknown models");
        assert.ok(MODEL_CATALOG.openai!.some((m) => m.id === "gpt-4o"), "static catalog ships known models");

        // ── router switching ──────────────────────────────────────────
        const registry = new ProviderRegistry();
        registry.register(mockProvider("p1"));
        registry.register(mockProvider("p2"));
        const router = new ProviderRouter(registry, "p1");
        assert.equal(router.providerId, "p1");
        assert.throws(() => router.setActiveProvider("nope"), UnknownProviderError, "switching to unknown provider throws");
        router.setActiveProvider("p2");
        assert.equal(router.providerId, "p2", "switching works");
        const resp = await router.chat({ sessionId: "s", model: "m1", systemPrompt: "", messages: [], tools: [] } as ContextType);
        assert.equal(resp.type === "text" ? resp.content : "", "p2:ok", "router delegates to the active provider");

        console.log("PASS — provider registration, credentials, custom providers, selection, and switching verified.");
    } finally {
        restoreEnv(saved);
    }
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
