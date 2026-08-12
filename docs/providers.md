# Provider & Model Configuration

NightCode's LLM layer is provider-neutral. The agent loop speaks one internal
interface (`LLMProvider` → `ChatLLM`); each provider is a thin adapter that
translates its own wire format into NightCode's normalized types (streaming
events, tool calls, reasoning, usage, errors). **Adding a provider never
touches the agent core** — you either pick one of the built-in presets, add a
custom entry in `nightcode.config.json`, or (for a brand-new wire format) add
one transport file.

```
                  NightCode Agent
                        │
                        ▼
             Provider-Neutral LLM Layer   (llm-client/)
             registry · router · stream · errors · auth
             ┌──────────────┼───────────────┬─────────────┐
             ▼              ▼               ▼             ▼
   OpenAI-compatible   Anthropic         Google         Cloud
   (one transport)     adapter           adapter         adapters
   Groq · DeepSeek     Claude            Gemini         Azure · Vertex
   OpenRouter · xAI    (thinking)        (thinking)     Bedrock (SigV4)
   Together · NVIDIA
   Cerebras · Mistral
   Fireworks · HF · ZAI
   MiniMax · Kimi
   Ollama · llama.cpp · LM Studio · vLLM
   Cloudflare · Vercel Gateway · any custom endpoint
```

---

## Quick start

```bash
# 1. Copy the template and fill in the keys you use
cp .env.example .env          # Bun auto-loads .env from the repo root

# 2. (optional) pick a provider + model explicitly
#    env:  NIGHTCODE_PROVIDER=deepseek  NIGHTCODE_MODEL=deepseek-chat
#    or:   nightcode.config.json → { "provider": "deepseek", "model": "deepseek-chat" }

# 3. Run
bun run dev:cli
```

Without any explicit choice, NightCode keeps its historical behavior: it
defaults to **Groq** (`llama-3.3-70b-versatile`). If no key is set for the default,
it auto-selects the first provider (in priority order) that *does* have a key,
and if none do, it stops with a boot message explaining exactly what to set.
Keys are **never** hardcoded and **never** logged.

---

## Supported providers

| Provider id | Display | Transport | Auth | Env vars |
|---|---|---|---|---|
| `groq` | Groq *(default)* | OpenAI-compatible | API key | `GROQ_API_KEY` |
| `openai` | OpenAI | OpenAI-compatible | API key | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | Anthropic (dedicated) | API key | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | Google (dedicated) | API key | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |
| `deepseek` | DeepSeek | OpenAI-compatible | API key | `DEEPSEEK_API_KEY` |
| `mistral` | Mistral | OpenAI-compatible | API key | `MISTRAL_API_KEY` |
| `xai` | xAI (Grok) | OpenAI-compatible | API key | `XAI_API_KEY` / `GROK_API_KEY` |
| `cerebras` | Cerebras | OpenAI-compatible | API key | `CEREBRAS_API_KEY` |
| `together` | Together AI | OpenAI-compatible | API key | `TOGETHER_API_KEY` |
| `fireworks` | Fireworks AI | OpenAI-compatible | API key | `FIREWORKS_API_KEY` |
| `openrouter` | OpenRouter | OpenAI-compatible | API key | `OPENROUTER_API_KEY` |
| `nvidia` | NVIDIA NIM | OpenAI-compatible | API key | `NVIDIA_API_KEY` |
| `huggingface` | Hugging Face | OpenAI-compatible | API key | `HF_API_KEY` / `HUGGINGFACE_API_KEY` |
| `zai` | ZAI (01.AI) | OpenAI-compatible | API key | `ZAI_API_KEY` |
| `minimax` | MiniMax | OpenAI-compatible | API key | `MINIMAX_API_KEY` |
| `kimi` | Kimi (Moonshot) | OpenAI-compatible | API key | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| `opencode-zen` | OpenCode Zen | OpenAI-compatible | API key | `OPENCODE_ZEN_API_KEY` / `OPENCODE_API_KEY` |
| `opencode-go` | OpenCode Go | OpenAI-compatible | API key | `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` |
| `vercel-gateway` | Vercel AI Gateway | OpenAI-compatible | API key | `AI_GATEWAY_TOKEN` |
| `cloudflare-gateway` | Cloudflare AI Gateway | OpenAI-compatible | API token | `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` + `CF_GATEWAY_SLUG` |
| `cloudflare-workers` | Cloudflare Workers AI | OpenAI-compatible | API token | `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| `azure` | Azure OpenAI | Azure (dedicated) | API key | `AZURE_OPENAI_API_KEY` + resource/deployment/version (below) |
| `vertex` | Google Vertex AI | Vertex (dedicated) | OAuth / ADC | see below |
| `bedrock` | Amazon Bedrock | Bedrock (dedicated, SigV4) | AWS credentials | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`) |
| `ollama` | Ollama *(local)* | OpenAI-compatible | none | `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) |
| `llama-cpp` | llama.cpp *(local)* | OpenAI-compatible | none | `LLAMACPP_BASE_URL` (default `http://localhost:8080/v1`) |
| `lmstudio` | LM Studio *(local)* | OpenAI-compatible | none | `LMSTUDIO_BASE_URL` (default `http://localhost:1234/v1`) |
| `vllm` | vLLM *(local)* | OpenAI-compatible | none | `VLLM_BASE_URL` (default `http://localhost:8000/v1`) |
| `custom` | Custom (config) | configurable | config/env | your own |

> All the "OpenAI-compatible" rows share **one transport** (`transports/openai-compatible.ts`)
> configured with base URL + key + model catalog. A provider whose API differs
> (Anthropic, Gemini, Azure, Vertex, Bedrock) gets a dedicated adapter.

### Cloud-specific setup

**Azure OpenAI** — three config values (env or `nightcode.config.json` → provider override):

```bash
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_RESOURCE=my-resource      # → https://my-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o-deploy  # the deployment name
AZURE_OPENAI_API_VERSION=2024-06-01    # optional
```

**Vertex AI** — OAuth-based, no API key. Provide one of:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json   # preferred
# or GOOGLE_APPLICATION_CREDENTIALS_JSON='{...}'                # inline JSON
# or GOOGLE_OAUTH_ACCESS_TOKEN=ya29...                          # short-lived token
GOOGLE_CLOUD_PROJECT=my-project
GOOGLE_CLOUD_REGION=us-central1
```

**Amazon Bedrock** — AWS credentials, requests signed with SigV4:

```bash
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...                  # only for temporary credentials
AWS_REGION=us-east-1
```

**Cloudflare** — the base URL contains `{account_id}` (and `{gateway_slug}`
for the AI Gateway) placeholders filled from env at startup:

```bash
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...              # fills {account_id}
CF_GATEWAY_SLUG=...                    # AI Gateway only — fills {gateway_slug}
```

---

## Selecting a provider & model

Precedence (high → low):

1. **CLI/env override** — `NIGHTCODE_PROVIDER`, `NIGHTCODE_MODEL`
2. **Config file** — `nightcode.config.json` (`provider`, `model`, `reasoning`)
3. **Auto-selection** — the first provider with credentials present (priority: Groq → OpenAI → Anthropic → Gemini → DeepSeek → Mistral → xAI → Together → Fireworks → OpenRouter → Cerebras → NVIDIA)
4. **Static defaults** — Groq + `llama-3.3-70b-versatile` (what NightCode shipped with)

Per-provider credentials resolve as: **config-file `apiKey` → `apiKeyEnv` env var(s) → `apiKeyEnv` defaults from the preset**. Local providers need no key.

**In the UI:** `Ctrl+M` opens the model selector — providers are grouped with
their models, you can search/filter, and favorites + recent picks are
remembered per-user at `~/.nightcode/model-preferences.json` (never in the
repo). Switching provider/model there takes effect for the next turn.

---

## Configuration file: `nightcode.config.json`

Lives at the repo root (or wherever `NIGHTCODE_CONFIG` points). Fully optional.

```jsonc
{
  "provider": "deepseek",          // default provider id
  "model": "deepseek-chat",        // default model within it
  "reasoning": "off",              // off | low | medium | high | max
  "providers": {
    "my-provider": {               // any id — registers a NEW provider, no source change
      "api": "openai-compatible",  // "openai-compatible" | "anthropic" | "google"
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-...",          // optional (prefer env) — overrides env
      "apiKeyEnv": "MY_PROVIDER_KEY",   // optional — read from env instead
      "requiresKey": true,          // set false for keyless local/proxy endpoints
      "displayName": "My Provider",
      "headers": { "X-Custom": "value" },
      "requestOverrides": { "extra_body_field": true },
      "summarizerModel": "my-cheap-model",   // memory extraction
      "subagentModel": "my-cheap-model",     // spawn_subagent sessions
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "contextWindow": 131072,
          "maxOutputTokens": 8192,
          "reasoning": true,
          "reasoningEffort": true,
          "toolCalling": true,
          "parallelToolCalls": true,
          "vision": false,
          "structuredOutput": false,
          "developerMessages": false
        }
      ]
    }
  }
}
```

**Backward compatibility:** the legacy flat shape keeps working — `{ provider,
model, apiKey, baseUrl }` is detected and folded into a provider override for
the selected provider (with a log line saying so). Nothing is silently
discarded.

> **Keys in the config file are discouraged** — env vars are the safer default.
> If you do put one there, the repo root config is gitignored-adjacent:
> never commit it.

---

## Local models (Ollama, llama.cpp, LM Studio, vLLM)

Local providers need **no API key** and work offline. Start your server, then:

```bash
NIGHTCODE_PROVIDER=ollama NIGHTCODE_MODEL=llama3.3 bun run dev:cli
```

- **Ollama** — `ollama serve` → `http://localhost:11434/v1`; models are
  discovered dynamically from `GET /api/tags` (pull with `ollama pull llama3.3`).
- **llama.cpp** — run the server with `--jinja` (tool calling) at `http://localhost:8080/v1`.
- **LM Studio** — start the local server, models discovered from `GET /models`.
- **vLLM** — `vllm serve <model> --api-key token-abc123` (vLLM still expects
  *some* key — set `apiKey`/`apiKeyEnv` even though it's ignored).
- Override the URL via `OLLAMA_BASE_URL` / `LLAMACPP_BASE_URL` /
  `LMSTUDIO_BASE_URL` / `VLLM_BASE_URL`, or in the config file.

Model discovery is **best-effort**: if it fails (server down), NightCode falls
back to the static catalog + `NIGHTCODE_MODEL` and still boots.

---

## Adding a new provider or model

- **A new OpenAI-compatible endpoint** (self-hosted, proxy, another vendor) —
  add a `providers` entry in `nightcode.config.json` as above. **No source
  change needed.** If the endpoint needs no key (a local proxy, a self-hosted
  vLLM), set `"requiresKey": false`. Overriding a *built-in* provider id
  (e.g. `groq`) merges your settings over the preset — the transport family,
  base URL, and behavior flags stay intact.
- **A new model for an existing provider** — set `NIGHTCODE_MODEL` (works even
  if the model isn't in the static catalog; unknown models get sane defaults
  for tool calling/context) or add it to the catalog in
  `packages/cli/src/llm-client/models.ts` for full metadata (pricing, vision,
  reasoning, …).
- **A brand-new wire format** (not OpenAI/Anthropic/Google-compatible) — write
  one transport class implementing `LLMProvider` (see `transports/*.ts` for
  examples), then register it in `buildProviderSystem` in `index.ts`. The
  agent core is untouched.

---

## Capabilities & graceful degradation

Every model carries a capability set (`ModelSpec`/`Capabilities`):

```
streaming · toolCalling · parallelToolCalls · reasoning · reasoningEffort
vision · structuredOutput · systemMessages · developerMessages
maxContextTokens · maxOutputTokens
```

The transports **adapt requests to the model**: `reasoning_effort` is only
sent to models that support it, `developer`-role messages only where allowed
(OpenAI 4.1/o-series), parallel tool calls are serialized when unsupported,
structured output is skipped when unavailable. Unknown models default to
safe, conservative capabilities.

## Reasoning / thinking

One NightCode-level knob — `reasoning: off | low | medium | high | max`
(config file, or per-call) — is translated **inside each adapter**:

| Provider | Mapping |
|---|---|
| OpenAI (o-series, gpt-5) | `reasoning_effort: low/medium/high` |
| Anthropic | extended thinking with a token budget scaled by effort |
| Gemini | `thinkingConfig.thinkingBudget` |
| Others | parameter passed through when supported |

If a model can't reason, the option is silently ignored. Reasoning text is
surfaced separately from the final answer (`reasoning_delta` events /
`LLMResponse.reasoning`).

## Streaming

Every adapter normalizes its wire stream into one event format (`LLMEvent`):

```
text_delta · reasoning_delta · tool_call_start · tool_call_delta · tool_call_end
usage · finish · error
```

`LLMProvider.chat()` is a convenience that consumes the normalized stream and
returns the final response — that's what the agent loop currently uses, so
per-turn behavior is unchanged. The event stream is ready for incremental UI
rendering (a roadmap item; see README §6).

## Usage & cost

Usage is normalized to `{ inputTokens, outputTokens, reasoningTokens?,
cachedTokens?, totalTokens, estimatedCost }`. Cost is computed from the
catalog's per-1M-token pricing when known and returns **`"unknown"`**
otherwise — NightCode never invents pricing.

## Errors & retries

Provider failures are normalized to typed errors:

```
AuthenticationError · RateLimitError · InvalidRequestError · ModelNotFoundError
ContextLengthError · ProviderUnavailableError · TimeoutError · ToolCallingError
UnknownProviderError
```

Each carries `provider`, `model`, HTTP `status`, `retryable`, `retryAfter`
(when the server sends one), and a `safeMessage` with **no secrets**. Retries
use exponential backoff with a bounded count; rate limits respect
`Retry-After`. Invalid requests and authentication failures are **never**
retried. The old Groq-specific malformed-tool-call repair is preserved (as a
per-provider flag, `repairToolCalls`, on the Groq preset).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Boot error "provider X has no API key configured" | Set the env var (or config `apiKey`), choose another provider, or use a local provider like `ollama` |
| `401` / `AuthenticationError` | Wrong or missing key; check the env var name in the table above |
| `429` / `RateLimitError` | Back off — NightCode retries with backoff; check your provider's quota |
| `404` / `ModelNotFoundError` | Model id doesn't exist on that provider; run `Ctrl+M` and pick a catalog model |
| Context-length errors | Pick a model with a bigger window, or let summarization compress history |
| Local provider: connection refused | Server not running / wrong `*_BASE_URL`; Ollama needs `ollama serve` first |
| Provider switching has no effect | The selector applies on the **next turn** |
| `ToolCallingError` | The model tried an invalid tool call; switch to a tool-calling-capable model |
| Everything works but cost shows "unknown" | Model not in the static catalog; add it to `models.ts` with `pricing` |
