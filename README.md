# NightCode

A terminal-based AI coding agent — a full ReAct agent with an interactive terminal UI, an automatic memory system, slash commands, and subagent delegation, written in TypeScript and running on [Bun](https://bun.sh).

```text
✦  Welcome to NightCode  ✦
Ask something to get started
```

---

## Table of Contents

1. [What is NightCode](#1-what-is-nightcode)
2. [Quick Start](#2-quick-start)
3. [Implemented Features](#3-implemented-features)
4. [Current Architecture](#4-current-architecture)
5. [NightCode vs. Pi](#5-nightcode-vs-pi-terminal-agent)
6. [What's Left / Roadmap](#6-whats-left--roadmap)
7. [Project Layout & Docs](#7-project-layout--docs)

---

## 1. What is NightCode

NightCode is a coding agent that lives in your terminal. You chat with it, it investigates your codebase with real tools (`read`, `grep`, `bash`, …), makes edits, runs tests, and answers — all inside a rich terminal UI rendered with React (`@opentui`).

Highlights:

- **Real tool use** — 15 tools built in; the model sees a lean Pi-style surface of 9 (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `todoWrite`, `spawn_subagent`).
- **Automatic memory** — the agent learns durable facts, reusable rules, and notable events between sessions, stored in the repo root.
- **Safe by default** — destructive commands pause for explicit confirmation before running.
- **Cancellable** — `Esc` / `Ctrl+C` stops a run between steps; `^C^C` exits.
- **Self-checked** — 14 standalone assertion-based check scripts cover the provider layer (errors, streams, registry, transports incl. SigV4 vectors), the prompt/tool surface, loop, tools, cancellation, UI, and memory wiring.

> **Status:** a personal/hobby project with a provider-neutral LLM layer (25+ providers, BYOK) and no session persistence yet. See [§5](#5-nightcode-vs-pi-terminal-agent) for an honest comparison against Pi and [§6](#6-whats-left--roadmap) for what's next.

---

## 2. Quick Start

```bash
# 1. Install dependencies (bun workspace)
bun install

# 2. Set API keys — copy .env.example → .env and fill in what you use
#    (root .env is auto-loaded by Bun; never hardcoded — see docs/providers.md)
#    GROQ_API_KEY=...        # or any provider's key; the default stays Groq

# 3. Run the CLI
bun run dev:cli
```

Alternatively, from `packages/cli`: `cd ../../ && bun run --watch packages/cli/src/main.ts`.

**Runtime files** (all gitignored, created on first run, always in the repo root — never in the launch directory):

| Path | Contents |
|---|---|
| `memory/semantic.json` | durable facts about user/project/environment |
| `memory/procedural.md` | learned rules ("always do X before Y") |
| `memory/episodic/events.jsonl` | notable past events with embeddings |
| `logs/combined.log` | winston JSON log, all levels, 5 MB × 5 rotated |
| `logs/error.log` | warn+ only, 5 MB × 5 rotated |

**Running the checks:**

```bash
bun run packages/cli/src/agent/activity.check.ts      # and the other *.check.* files
bun run packages/cli/src/ui/scroll.check.tsx
```

**Keybindings:** `Esc` cancels an active run · `Ctrl+C` cancels (second press within 2s exits) · `Y`/`N` confirm or reject destructive actions.

---

## 3. Implemented Features

### 3.1 Agent core

| Feature | How |
|---|---|
| ReAct loop | `AgentLoop` runs up to 10 iterations of context → LLM → tool calls → result, until a final text answer |
| Streaming | Assistant text renders **live** as the model generates (Pi-style): the loop consumes the provider's normalized stream and forwards `text_delta` events to the UI; history still stores one complete message ([docs/streaming.md](docs/streaming.md)) |
| 15 tools | Model-visible surface is Pi-style: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `todoWrite`, `spawn_subagent` (the rest — `append`, `delete`, `mkdir`, `glob`, `rename`, `copy` — stay registered for scopes but aren't advertised) |
| Tool result handling | Shell tools return formatted stdout/stderr/exit code as a *result* (not an exception) so the agent can recover; structured `{ ok: false }` signals UI failure |
| Context window management | At ~100k estimated tokens, old messages are LLM-summarized (chainable across compressions), preserving the last 15 messages; hard fallbacks keep the window bounded |
| Human-in-the-loop | Destructive tools (`write`, `delete`, `rename`, `copy`, risky `bash`) pause for a `Y/N` confirmation dialog before executing |
| Cancellation | `AbortSignal` threads through the loop and tools; cancelled runs stop between steps, keep history valid, and kill child process trees (`taskkill /T /F` on Windows) |
| Subagents | `spawn_subagent` delegates a scoped, isolated sub-task to a fresh session with restricted tools and no memory writes |

### 3.2 Memory system

- **Semantic** (`semantic.json`) — durable facts stored as dot-paths (`user.stack.db`).
- **Procedural** (`procedural.md`) — reusable rules/corrections extracted from completed tasks.
- **Episodic** (`episodic/events.jsonl`) — notable events embedded via the Jina API, retrieved by cosine similarity.
- **Extraction** — on each completed turn, the active provider's cheap `summarizerModel` (Groq default: `llama-3.1-8b-instant`) turns the execution trace into the three categories; extraction is fire-and-forget so it never blocks the response.
- **Prompt injection** — memory is injected into the system prompt as "Known facts / Learned rules / Relevant past events".
- **Guard** — the `memory/` tree is off-limits to agent tools (read/write/edit/delete/grep are all blocked).

### 3.3 Slash commands

`commands/*.md` at the repo root are prompt templates with optional frontmatter (`description`, `allowed-tools`, `argument-hint`); `$ARGUMENTS` is substituted with the user's text. Built-ins: `/commit`, `/explain`, `/fix-issue`, `/review`, plus the UI-level `/clear`.

### 3.4 Terminal UI

- Chat bubbles with roles (`You` / `NightCode` / `Error`), Catppuccin-inspired palette
- **Markdown rendering** for assistant replies (headings, bold, code, lists, wrapping)
- **Real-time activity feed** — stage rows ("· loading memory"), iteration counters, live tool row with elapsed ticker, `✓/✗` results with bounded previews
- **Concise failure summaries** — `exit code N` + first stderr line, capped at 2 lines / 120 chars; `File not found: <path>` for missing reads
- **Live streaming replies** — assistant text renders incrementally as the model generates (Pi-style), in the same slot the final message lands in
- **Status bar** — model, session number, agent status (ready/running/cancelled/error)
- **Slash-command autocomplete menu** while typing
- **Narrow-width layout**, header meta hiding, one-line status bar
- **Scroll-follow** with sticky bottom, no viewport yanking on resize
- **Confirmation dialog** for destructive actions
- **Session management** — `/clear` starts a fresh session (backend history + summary reset, files/memory untouched); session numbers shown in the status bar

### 3.5 Observability & engineering

- **Logging** — winston JSON to `logs/` (combined + error), colorized console to stderr
- **Tracing** — OpenTelemetry spans across agent/loop/tool/memory with OTLP-HTTP export (`localhost:4318`)
- **Self-checks** — 14 `*.check.*` scripts (no framework, plain `node:assert` + `@opentui/react/test-utils`) covering provider errors, stream normalization, the provider registry, transports (mock servers + SigV4 test vectors), the model-visible prompt/tool surface, activity events, cancellation, commands, tools, subagents, markdown, scroll, session UX, and narrow-width layout
- **Repo-root storage** — `memory/`, `logs/`, and `commands/` are anchored to the project root via `src/paths.ts` (module-location-derived), so the CLI behaves identically from any launch directory

---

## 4. Current Architecture

```
nightCode/
├── package.json            # bun workspace root — `dev:cli` runs the CLI
├── tsconfig.base.json / tsconfig.json
├── commands/               # slash-command templates (commit, explain, fix-issue, review)
├── docs/                   # design notes (structure, event flow, error recovery, postmortems)
├── memory/  logs/          # runtime data — gitignored, pinned to root
└── packages/cli/
    └── src/
        ├── main.ts                 # entry point — boot & wiring (see below)
        ├── logger.ts  paths.ts  telemetry.ts   # shared infra
        ├── agent/                  # the agent subsystem
        │   ├── loop.ts             # AgentLoop — ReAct loop, cancellation, events, memory trigger
        │   ├── agent-harness.ts    # memory context build + task-complete extraction
        │   ├── context.ts          # ContextBuilder — Pi-style system prompt, 9-tool surface, summarization
        │   ├── commands.ts         # CommandRegistry + resolveSlashCommand
        │   ├── messages.ts  session.ts  registry.ts   # history / sessions / tool registry
        │   ├── tools.ts            # all 15 tools + destructive guards
        │   ├── memory/             # semantic / procedural / episodic managers + classifier
        │   └── *.check.ts          # agent self-checks
        ├── llm-client/             # provider-neutral LLM layer — registry, router, auth,
        │   │                       # errors, model catalog + transports/ (docs/providers.md)
        │   └── transports/         # openai-compatible · anthropic · google · azure · vertex · bedrock
        └── ui/                     # everything the terminal renders
            ├── index.tsx           # App — chat, activity feed, confirm dialog, keyboard
            ├── terminal.ts         # TerminalUI — opentui renderer, mounts App
            ├── markdown.tsx        # markdown renderer
            ├── header.tsx  input-bar.tsx  status-bar.tsx
            ├── commands-menu/      # slash-command autocomplete
            ├── model-menu/         # provider/model selector (Ctrl+M, search, favorites)
            └── *.check.tsx         # UI self-checks
```

**Dependency direction** (no cycles):

```
main.ts ──► agent ──► llm-client
   │            │
   └──────► ui ──► agent (types/loop)      ← agent never imports ui
              │
              ▼
        logger / paths / telemetry
```

**Boot order** (`src/main.ts`): load config + build the provider system (friendly boot error if no credentials) → construct managers (messages, sessions, tools, memory) → register 15 tools → build context builder, command registry (loads root `commands/`), harness, LLM router, loop → create first session → hand off to `TerminalUI`.

**How a turn flows:** user input → slash-command resolution → message stored (raw input kept) → memory context built once → ReAct iterations (`context.build` → `llm.stream` → tools) → final text answer stored → fire-and-forget memory extraction. Events (`stage`/`iteration`/`tool_start`/`tool_end`/`text_delta`) stream to the UI throughout — assistant text renders live (Pi-style). Full detail: [`docs/agent-event-flow.md`](docs/agent-event-flow.md) and [`docs/streaming.md`](docs/streaming.md).

---

## 5. NightCode vs. Pi (terminal agent)

**[Pi](https://github.com/earendil-works/pi)** (by Mario Zechner / Earendil Works) is a mature, MIT-licensed TypeScript monorepo: a modular agent toolkit + coding-agent CLI that ranks ~**#6 on [terminal-bench](https://www.tbench.ai/leaderboard/terminal-bench/2.0)** when paired with frontier models. NightCode is a lean single-app implementation of the same idea.

There are **two separate comparisons** to make, and conflating them is a mistake:

- **Feature parity** (§5.1) — the countable surface capabilities.
- **Benchmark drivers** (§5.2) — the handful of things that actually produce terminal-bench scores.

Pi's #6 rank is **not** explained by its feature list. It is explained by what §5.2 calls benchmark drivers.

### 5.1 Feature parity

| Dimension | NightCode | Pi |
|---|---|---|
| What it is | Single terminal coding agent (one package) | Monorepo: agent toolkit + coding-agent CLI (`pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent`) |
| Runtime / stack | Bun + TypeScript, React (`@opentui`) | TypeScript, custom differential-rendering TUI (`pi-tui`) |
| System prompt & tool surface | **Compact Pi-style prompt (~700 tokens)** + **9-tool model-visible surface** (Pi's 7 + `todoWrite` + `spawn_subagent`) + full memory dump every turn ([docs/prompt-and-tools.md](docs/prompt-and-tools.md)) | **<1,000-token** core prompt, **7 default tools** (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), no hidden scaffolding |
| Model providers | **25+** — OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral, OpenRouter, Bedrock, Vertex, Azure, Ollama, … one internal interface + per-provider adapters ([docs/providers.md](docs/providers.md)) | **20+** — with unified token normalization |
| Execution modes | Interactive TUI only | Interactive TUI, print/JSON (pipes), RPC, embeddable SDK |
| Streaming | ✅ **Live assistant-text rendering** — the loop consumes the provider's normalized stream and the UI types the answer out as it arrives ([docs/streaming.md](docs/streaming.md)); reasoning/tool-argument deltas are normalized but only text renders so far | ✅ Real-time streaming of thoughts/tools/text |
| Session state | ❌ Linear history, in-memory (lost on exit) | ✅ **Tree-structured DAG** saved as JSONL (`~/.pi/agent/sessions/`), with `/tree`, `/fork`, `/clone`, `/compact` |
| Context loading | ✅ LLM summarization past ~100k tokens (chained) | ✅ Compaction + branch summarization into structured checkpoints |
| Memory | ✅ Automatic semantic/procedural/episodic memory (Groq classifier + Jina embeddings), persisted to repo root | No cross-session "fact" memory by default — relies on `AGENTS.md` + skills + compaction |
| Progressive disclosure | ❌ Memory injected wholesale into every system prompt | ✅ Only `AGENTS.md`/`CLAUDE.md` blocks + skill **names** in the prompt; full skill read on demand via `read` |
| Tools | 15 built-in; **9 model-visible** (Pi-style surface — see [docs/prompt-and-tools.md](docs/prompt-and-tools.md)); 6 registered-but-hidden | 7 built-in + **extension-registered** tools (`defineTool`, `--tools`/`--exclude-tools` filters) |
| Subagents | ✅ Built-in `spawn_subagent` tool (scoped, isolated) | ✅ Flexible multi-agent primitives via extensions |
| Slash commands | ✅ `commands/*.md` templates + `/clear` | ✅ Built-in + extension-registered (`.pi/prompts/`) |
| Mid-turn steering | ❌ No | ✅ `steer`/`followUp` message queueing — inject corrections without aborting the turn |
| Extension system | ❌ None (fork the code) | ✅ Extensions: tools, commands, hooks, skills, UI overlays, themes |
| Permissions / confirmation | ✅ Built-in HITL confirmation for destructive tools | ❌ No sandbox; **project-trust** model (`trust.json`, `defaultProjectTrust`) + docs recommend containers (Gondolin / Docker / OpenShell) |
| Observability | winston logs + OpenTelemetry (OTLP) | `pi-telemetry` contracts |
| License / maturity | Personal project | MIT, actively maintained, active roadmap (local models, deferred tool loading) |

### 5.2 Benchmark drivers — why Pi ranks ~#6 and NightCode doesn't

Terminal-bench measures **real CLI task completion** — git workflows, package managers, servers, databases, debugging — inside containers with strict verifiers, binary pass/fail. Two facts about the benchmark drive everything:

1. **The model is the score.** Leaderboard rankings mostly reflect the underlying LLM (frontier reasoning models dominate the top — 80%+). The harness cannot out-reason the model; it can only amplify or sabotage it.
2. **A bloated harness sabotages the model.** Huge system prompts, tool zoos, and hidden injections burn context headroom and cause truncation failures.

| Driver | Pi | NightCode | Leverage for NightCode |
|---|---|---|---|
| **Model access** | 20+ providers → can run Claude/GPT-class models | **25+ providers** — BYOK: OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral, OpenRouter, Bedrock, local (Ollama/vLLM/…) | ✅ Closed — was the single biggest gap |
| **Harness minimalism** | <1,000-token prompt, 7 tools, transparent channel to the shell | Compact Pi-style prompt (~700 tokens) + 9-tool surface; memory dump still injected every turn | 🔥🔥 High — partially addressed; headroom still spent on the memory dump. |
| **Progressive disclosure** | Context/skills loaded on demand, never pre-injected | Full semantic + procedural memory injected into every system prompt | 🔥🔥 Medium-high — same headroom argument. |
| **Eval-harness integration** | print/JSON + RPC modes; **Harbor adapter** (`badlogic/pi-terminal-bench`) | Interactive TUI only — cannot even be benchmarked as-is | 🔥 Medium — required to measure anything. |
| **Session state** | Tree DAG — branch/retry/compact without losing context | Linear, in-memory | 🔥 Low for benchmark scores; high for real-world UX |

**Bottom line:** Pi's rank comes from (1) frontier-model access and (2) keeping the model's context clean — **not** from its feature count. Porting every missing feature to NightCode would barely move a benchmark score while it is locked to a mid-tier model and injects a memory dump into every prompt.

NightCode's genuine advantages remain: **built-in destructive-action confirmation** (Pi leaves sandboxing to you) and a **true automatic long-term memory** (semantic/procedural/episodic) that Pi doesn't have by default.

---

## 6. What's Left / Roadmap

The roadmap is split into two tracks, because "missing" means two different things:

- **Track A — benchmark drivers:** changes that actually move terminal-bench performance.
- **Track B — feature parity & UX:** nice-to-haves that round out the product but don't move scores.

### 6.1 Track A — benchmark drivers

1. ~~**Provider-agnostic client**~~ ✅ **Done** — provider-neutral LLM layer with 25+ providers, BYOK env config, per-provider adapters, normalized streaming/errors/usage ([docs/providers.md](docs/providers.md)).
2. **Slim the system prompt & tool surface** 🔥🔥 — ⏳ partially done: Pi-style compact prompt + 9-tool model-visible surface ([docs/prompt-and-tools.md](docs/prompt-and-tools.md)); remaining piece is removing the mid-session memory dump (progressive disclosure).
3. **Progressive memory disclosure** 🔥🔥 — stop injecting the full semantic/procedural dump every turn; inject a compact summary or only the slices relevant to the current query (episodic retrieval is already query-relative).
4. **Non-interactive mode + eval adapter** 🔥 — a print/JSON execution mode so NightCode can run under terminal-bench/Harbor and be measured at all.
5. **Session tree / branching** — DAG history with fork/retry/compact, mirroring Pi's `/tree` `/fork` `/clone`.

### 6.2 Track B — feature parity & UX

1. ~~**Move hardcoded API keys to env**~~ ✅ **Done** — no keys in source; `.env` + `nightcode.config.json` are authoritative.
2. **Session persistence** — history/sessions are in-memory; survive restarts with JSONL or SQLite.
3. ~~**Streaming output**~~ ✅ **Done** — providers normalize streams (`text_delta`, `reasoning_delta`, `tool_call_*`); the loop consumes them and the UI renders assistant text live ([docs/streaming.md](docs/streaming.md)). Remaining: rendering reasoning/thinking text.
4. **Extension/skill system** — let users add tools/commands without forking (the `commands/` templates are a first step toward Pi-style skills).
5. **Sensitive-file validation layer** (from `things-left.md`) — block tools from modifying files containing personal/sensitive data.
6. **More tools** (from `things-left.md`) — e.g. git integration beyond raw `bash`.
7. **Review context compaction** (from `things-left.md`) — re-read `context.ts` summarization; consider Pi-style checkpoint summaries.
8. **A real test framework** — the assert-based `*.check.*` scripts work but don't scale; migrate when the suite grows.
9. **Longer term** — Ollama/vLLM/llama.cpp/LM Studio already work as providers (see docs/providers.md); next: MCP integration, vision/image input, agent-evaluation loop.

### Known limitations
- No provider failover mid-session — the active provider is fixed at boot; switch via `Ctrl+M` or config.
- No sandboxing beyond the destructive-command regex + confirmation dialog (same stance as Pi's default).
- Memory extraction depends on the active provider + Jina network calls; if they fail, extraction silently degrades (logged, never fatal).
- Episodic recall is similarity-based over a JSONL file — no dedup or forgetting policy yet.
- Session persistence is still on the roadmap; reasoning/thinking text is normalized but not yet rendered.

---

## 7. Project Layout & Docs

| Doc | Contents |
|---|---|
| [`docs/structure.md`](docs/structure.md) | Full module map, dependency direction, storage conventions, check conventions |
| [`docs/agent-event-flow.md`](docs/agent-event-flow.md) | AgentEvent pipeline: types → loop → UI rendering |
| [`docs/error-recovery.md`](docs/error-recovery.md) | Tool failure signaling (`{ ok: false }`) and concise error summaries |
| [`docs/cancel-latency-postmortem.md`](docs/cancel-latency-postmortem.md) | Cancellation latency fix and watchdog design |
| [`docs/providers.md`](docs/providers.md) | Provider-neutral LLM layer — providers, auth, custom/local models, troubleshooting |
| [`docs/prompt-and-tools.md`](docs/prompt-and-tools.md) | Pi-style system prompt + model-visible tool surface — structure, customization, interactions |
| [`docs/streaming.md`](docs/streaming.md) | Streaming pipeline — provider events → loop → live UI rendering |

**Conventions:** checks live next to the code they test (`*.check.ts` / `*.check.tsx`, run directly) · runtime data always goes to the repo root via `src/paths.ts` · `ui/` may import `agent/` types, never the reverse · no `utils/`/`helpers/` dumping grounds — group by responsibility.

---

*Created with Bun. Terminal UI by [`@opentui`](https://github.com/anomalyco/opentui).*
