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

- **Real tool use** — 15 tools including file operations, ripgrep search, and shell execution.
- **Automatic memory** — the agent learns durable facts, reusable rules, and notable events between sessions, stored in the repo root.
- **Safe by default** — destructive commands pause for explicit confirmation before running.
- **Cancellable** — `Esc` / `Ctrl+C` stops a run between steps; `^C^C` exits.
- **Self-checked** — 10 standalone assertion-based check scripts cover loop, tools, cancellation, UI, and memory wiring.

> **Status:** a personal/hobby project, currently single-model (Groq) with no session persistence. See [§5](#5-nightcode-vs-pi-terminal-agent) for an honest comparison against Pi and [§6](#6-whats-left--roadmap) for what's next.

---

## 2. Quick Start

```bash
# 1. Install dependencies (bun workspace)
bun install

# 2. Set the Groq API key
#    (root .env is auto-loaded by Bun; keys are currently also hardcoded — see §6)
#    GROQ_API_KEY=...

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
| 15 tools | `read`, `write`, `append`, `edit`, `delete`, `mkdir`, `ls`, `glob`, `find`, `grep` (ripgrep), `rename`, `copy`, `bash`, `todoWrite`, `spawn_subagent` |
| Tool result handling | Shell tools return formatted stdout/stderr/exit code as a *result* (not an exception) so the agent can recover; structured `{ ok: false }` signals UI failure |
| Context window management | At ~100k estimated tokens, old messages are LLM-summarized (chainable across compressions), preserving the last 15 messages; hard fallbacks keep the window bounded |
| Human-in-the-loop | Destructive tools (`write`, `delete`, `rename`, `copy`, risky `bash`) pause for a `Y/N` confirmation dialog before executing |
| Cancellation | `AbortSignal` threads through the loop and tools; cancelled runs stop between steps, keep history valid, and kill child process trees (`taskkill /T /F` on Windows) |
| Subagents | `spawn_subagent` delegates a scoped, isolated sub-task to a fresh session with restricted tools and no memory writes |

### 3.2 Memory system

- **Semantic** (`semantic.json`) — durable facts stored as dot-paths (`user.stack.db`).
- **Procedural** (`procedural.md`) — reusable rules/corrections extracted from completed tasks.
- **Episodic** (`episodic/events.jsonl`) — notable events embedded via the Jina API, retrieved by cosine similarity.
- **Extraction** — on each completed turn, a Groq classifier (`llama-3.1-8b-instant`) turns the execution trace into the three categories; extraction is fire-and-forget so it never blocks the response.
- **Prompt injection** — memory is injected into the system prompt as "Known facts / Learned rules / Relevant past events".
- **Guard** — the `memory/` tree is off-limits to agent tools (read/write/edit/delete/grep are all blocked).

### 3.3 Slash commands

`commands/*.md` at the repo root are prompt templates with optional frontmatter (`description`, `allowed-tools`, `argument-hint`); `$ARGUMENTS` is substituted with the user's text. Built-ins: `/commit`, `/explain`, `/fix-issue`, `/review`, plus the UI-level `/clear`.

### 3.4 Terminal UI

- Chat bubbles with roles (`You` / `NightCode` / `Error`), Catppuccin-inspired palette
- **Markdown rendering** for assistant replies (headings, bold, code, lists, wrapping)
- **Real-time activity feed** — stage rows ("· loading memory"), iteration counters, live tool row with elapsed ticker, `✓/✗` results with bounded previews
- **Concise failure summaries** — `exit code N` + first stderr line, capped at 2 lines / 120 chars; `File not found: <path>` for missing reads
- **Status bar** — model, session number, agent status (ready/running/cancelled/error)
- **Slash-command autocomplete menu** while typing
- **Narrow-width layout**, header meta hiding, one-line status bar
- **Scroll-follow** with sticky bottom, no viewport yanking on resize
- **Confirmation dialog** for destructive actions
- **Session management** — `/clear` starts a fresh session (backend history + summary reset, files/memory untouched); session numbers shown in the status bar

### 3.5 Observability & engineering

- **Logging** — winston JSON to `logs/` (combined + error), colorized console to stderr
- **Tracing** — OpenTelemetry spans across agent/loop/tool/memory with OTLP-HTTP export (`localhost:4318`)
- **Self-checks** — 10 `*.check.*` scripts (no framework, plain `node:assert` + `@opentui/react/test-utils`) covering activity events, cancellation, commands, tools, subagents, Groq error mapping, markdown, scroll, session UX, and narrow-width layout
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
        │   ├── context.ts          # ContextBuilder — system prompt, tool list, summarization
        │   ├── commands.ts         # CommandRegistry + resolveSlashCommand
        │   ├── messages.ts  session.ts  registry.ts   # history / sessions / tool registry
        │   ├── tools.ts            # all 15 tools + destructive guards
        │   ├── memory/             # semantic / procedural / episodic managers + classifier
        │   └── *.check.ts          # agent self-checks
        ├── llm-client/             # LLMClient interface + GroqClient implementation
        └── ui/                     # everything the terminal renders
            ├── index.tsx           # App — chat, activity feed, confirm dialog, keyboard
            ├── terminal.ts         # TerminalUI — opentui renderer, mounts App
            ├── markdown.tsx        # markdown renderer
            ├── header.tsx  input-bar.tsx  status-bar.tsx
            ├── commands-menu/      # slash-command autocomplete
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

**Boot order** (`src/main.ts`): guard API key → construct managers (messages, sessions, tools, memory) → register 15 tools → build context builder, command registry (loads root `commands/`), harness, Groq client, loop → create first session → hand off to `TerminalUI`.

**How a turn flows:** user input → slash-command resolution → message stored (raw input kept) → memory context built once → ReAct iterations (`context.build` → `llm.chat` → tools) → final text answer stored → fire-and-forget memory extraction. Events (`stage`/`iteration`/`tool_start`/`tool_end`) stream to the UI throughout. Full detail: [`docs/agent-event-flow.md`](docs/agent-event-flow.md).

---

## 5. NightCode vs. Pi (terminal agent)

**[Pi](https://github.com/earendil-works/pi)** (by Mario Zechner / Earendil Works) is a mature, MIT-licensed TypeScript monorepo: a modular agent toolkit + coding-agent CLI, built for extensibility and provider agnosticism. NightCode is a lean single-app implementation of the same idea. The comparison is honest — Pi is far more complete; NightCode's strengths are its built-in safety confirmation, automatic memory, and simplicity.

| Dimension | NightCode | Pi |
|---|---|---|
| What it is | Single terminal coding agent (one package) | Monorepo: agent toolkit + coding-agent CLI (`pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent`) |
| Runtime / stack | Bun + TypeScript, React (`@opentui`) | TypeScript, custom differential-rendering TUI (`pi-tui`) |
| Model providers | **1** — Groq (`qwen/qwen3.6-27b` main, `llama-3.1-8b-instant` subagent/summarizer) | **20+** — Anthropic, OpenAI, Gemini, Groq, Ollama, Bedrock, OpenRouter, … with unified token normalization |
| Execution modes | Interactive TUI only | Interactive TUI, print/JSON (pipes), RPC, embeddable SDK |
| Streaming | ❌ No — full response per turn | ✅ Real-time streaming of thoughts/tools/text |
| Session persistence | ❌ In-memory only (lost on exit) | ✅ Tree-structured history saved as JSONL |
| Memory | ✅ Automatic semantic/procedural/episodic memory (Groq classifier + Jina embeddings), persisted to repo root | Context compaction with branch summarization; no cross-session "fact" memory by default |
| Context management | ✅ LLM summarization past ~100k tokens (chained) | ✅ Compaction + branch summarization into structured checkpoints |
| Tools | 15 built-in (file, shell, ripgrep, todo, subagent) | Foundational tools + **extension-registered** tools |
| Subagents | ✅ Built-in `spawn_subagent` tool (scoped, isolated) | ✅ Flexible multi-agent primitives via extensions |
| Slash commands | ✅ `commands/*.md` templates + `/clear` | ✅ Built-in + extension-registered |
| Extension system | ❌ None (fork the code) | ✅ Extensions: tools, commands, hooks, skills, UI overlays, themes |
| Permissions / confirmation | ✅ Built-in HITL confirmation for destructive tools | ❌ None by default — runs with full user permissions (docs recommend containers: Gondolin / Docker / OpenShell) |
| Observability | winston logs + OpenTelemetry (OTLP) | `pi-telemetry` contracts |
| License / maturity | Personal project | MIT, actively maintained, active roadmap (local models, deferred tool loading) |

**Bottom line:** Pi wins on breadth — providers, streaming, persistence, extensions, and non-interactive modes. NightCode wins on two things today: **built-in destructive-action confirmation** (Pi leaves sandboxing to you) and a **true automatic long-term memory** (semantic/procedural/episodic) that persists across sessions. NightCode's `memory/` system is the closest thing to a differentiator.

---

## 6. What's Left / Roadmap

Tracked gaps, roughly in priority order:

### Near term (small, high value)
1. **Session persistence** — history and sessions are in-memory; survive restarts with JSONL (Pi-style) or SQLite.
2. **Streaming output** — render the LLM response incrementally instead of per-turn.
3. **Multi-provider support** — the `LLMClient` interface already abstracts this; add a client factory + env-key config.
4. **Move hardcoded API keys to env** — Groq/Jina keys are currently baked into source (`.env` is loaded but not authoritative); this is a security issue.
5. **Sensitive-file validation layer** (from `things-left.md`) — block tools from modifying files containing personal/sensitive data.
6. **More tools** (from `things-left.md`) — e.g. git integration beyond raw `bash`.

### Medium term
7. **Review context compaction** (from `things-left.md`) — re-read `context.ts` summarization; consider Pi-style checkpoint summaries.
8. **Non-interactive mode** — print/JSON output for scripts and pipelines.
9. **Extension/skill system** — let users add tools/commands without forking (the `commands/` templates are a first step).
10. **A real test framework** — the assert-based `*.check.*` scripts work but don't scale; migrate when the suite grows.

### Longer term
11. Local model support (Ollama), MCP integration, vision/image input, agent-evaluation harness (Pi is publishing training sessions to Hugging Face; an open eval loop would help).

### Known limitations
- Single model/provider; no fallback.
- No sandboxing beyond the destructive-command regex + confirmation dialog (same stance as Pi's default).
- Memory extraction depends on Groq + Jina network calls; if they fail, extraction silently degrades (logged, never fatal).
- Episodic recall is similarity-based over a JSONL file — no dedup or forgetting policy yet.

---

## 7. Project Layout & Docs

| Doc | Contents |
|---|---|
| [`docs/structure.md`](docs/structure.md) | Full module map, dependency direction, storage conventions, check conventions |
| [`docs/agent-event-flow.md`](docs/agent-event-flow.md) | AgentEvent pipeline: types → loop → UI rendering |
| [`docs/error-recovery.md`](docs/error-recovery.md) | Tool failure signaling (`{ ok: false }`) and concise error summaries |
| [`docs/cancel-latency-postmortem.md`](docs/cancel-latency-postmortem.md) | Cancellation latency fix and watchdog design |

**Conventions:** checks live next to the code they test (`*.check.ts` / `*.check.tsx`, run directly) · runtime data always goes to the repo root via `src/paths.ts` · `ui/` may import `agent/` types, never the reverse · no `utils/`/`helpers/` dumping grounds — group by responsibility.

---

*Created with Bun. Terminal UI by [`@opentui`](https://github.com/anomalyco/opentui).*
