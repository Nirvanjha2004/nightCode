# Project Structure — NightCode

This document describes the directory layout and module responsibilities of the
NightCode codebase, after the structure refactor that consolidated all UI code
under `packages/cli/src/ui/`.

---

## 1. Stack

| Concern | Choice |
|---|---|
| Runtime | Bun (`bun run` — source files run directly, no build step) |
| Language | TypeScript (strict), React 19 with the `@opentui` terminal renderer |
| LLM | Groq SDK (`groq-sdk`) — chat + memory classification |
| Embeddings | Jina API (episodic memory) |
| Logging | winston (JSON file transports + colorized console) |
| Tracing | OpenTelemetry SDK, OTLP-HTTP export to `localhost:4318` |

---

## 2. Repository layout (root)

```
nightCode/
├── package.json            # workspace root; `dev:cli` runs the CLI
├── tsconfig.json           # extends tsconfig.base.json, includes packages/cli
├── tsconfig.base.json
├── bun.lock
├── .env                    # API keys (gitignored)
├── Agents.md               # agent operating instructions
├── README.md
├── things-left.md          # personal notes
├── commands/               # slash-command templates (see §7)
├── docs/                   # design notes (this document included)
├── memory/                 # runtime agent memory — gitignored (see §6)
├── logs/                   # runtime logs — gitignored (see §6)
└── packages/
    └── cli/                # the terminal CLI application
```

Root-level config files (`package.json`, `tsconfig*.json`) stay where they
conventionally belong. The `commands/`, `memory/`, and `logs/` directories are
pinned to the repo root regardless of where the CLI is launched (see §6).

---

## 3. `packages/cli/src` — module map

The source is grouped by **responsibility**. Each module only depends on the
layers below it; there are no circular imports.

```
src/
├── main.ts                 # entry point — boot + wiring (see §4)
├── logger.ts               # winston logger → <root>/logs/
├── paths.ts                # PROJECT_ROOT / MEMORY_DIR / LOGS_DIR (cwd-independent)
├── telemetry.ts            # OpenTelemetry SDK + SIGINT/SIGTERM shutdown
│
├── agent/                  # the agent subsystem
│   ├── types.ts            # shared types: MessageType, SessionType, Tool, AgentEvent, ContextType, …
│   ├── loop.ts             # AgentLoop — ReAct loop, cancellation, events, memory trigger
│   ├── agent-harness.ts    # AgentHarness — wires loop↔tools↔memory; memory context + extraction
│   ├── context.ts          # ContextBuilder — system prompt, tool list, context-window summarization
│   ├── commands.ts         # CommandRegistry — slash commands; resolveSlashCommand
│   ├── messages.ts         # MessageManager — in-memory conversation history
│   ├── session.ts          # SessionManager — in-memory session records
│   ├── registry.ts         # ToolRegistry — tool registration + allowed-tool filtering
│   ├── tools.ts            # all 15 agent tools (file, shell, glob, todo, subagent) + guards
│   ├── memory/             # background memory pipeline
│   │   ├── EpisodicMemoryManager.ts   # Jina embeddings → memory/episodic/events.jsonl
│   │   ├── SemanticMemoryManager.ts   # durable facts → memory/semantic.json
│   │   ├── ProceduralMemoryManager.ts # learned rules → memory/procedural.md
│   │   ├── memoryClassifier.ts        # Groq extraction of semantic/procedural/episodic
│   │   └── types.ts
│   └── *.check.ts          # self-checks (see §8)
│
├── llm-client/             # LLM abstraction
│   ├── client.ts           # LLMClient interface
│   ├── groq-client.ts      # GroqClient implementation (abort, retries, error mapping)
│   ├── types.ts            # LLMResponse, … 
│   └── groq-client.check.ts
│
└── ui/                     # everything the terminal renders
    ├── index.tsx           # App — chat UI, activity feed, confirm dialog, keyboard/cancel
    ├── terminal.ts         # TerminalUI — creates the opentui renderer, mounts App
    ├── markdown.tsx        # markdown renderer for assistant replies
    ├── header.tsx          # header bar
    ├── input-bar.tsx       # prompt input + slash-command menu trigger
    ├── status-bar.tsx      # status/model/session display
    ├── commands-menu/      # slash-command autocomplete
    │   ├── index.tsx
    │   ├── types.ts
    │   ├── filter-commands.ts
    │   └── use-command-menu.ts
    └── *.check.tsx         # UI self-checks
```

### Dependency direction

```
main.ts ──► agent ──► llm-client          (loop.llm)
   │           │
   │           ▼
   └──────► ui ──► agent (types, loop)    (UI never imported by agent code)
              │
              ▼
        logger / paths / telemetry
```

- `ui/` imports types and the loop from `agent/`; nothing in `agent/` imports `ui/`.
- `logger.ts`, `paths.ts`, `telemetry.ts` are leaf modules — the rest depends on them, they depend on nothing internal.
- `agent/memory/` managers are self-contained; `agent-harness.ts` drives them.

---

## 4. Entry point — `packages/cli/src/main.ts`

The application entry is `main.ts`; the `dev` / `dev:cli` scripts point at it and it
is **not** moved or renamed.

Boot order (see the file for details):

1. Guard the Groq API key.
2. Construct managers: `MessageManager`, `SessionManager`, `ToolRegistry`, and the three
   memory managers (paths default to `<root>/memory/…`).
3. Register all 15 tools.
4. Build `ContextBuilder` (Groq client), `CommandRegistry` (loads `<root>/commands/`),
   `AgentHarness`, `GroqClient`, `AgentLoop`.
5. Create the first session, then hand off to `TerminalUI` (`src/ui/terminal.ts`).

`packages/cli/package.json` also declares `"module": "src/ui/index.tsx"` — the UI root,
kept accurate after the refactor (the App lives at `src/ui/index.tsx`).

---

## 5. What each module is for

| Module | Responsibility | Key files |
|---|---|---|
| `agent/` | ReAct agent: build context → call LLM → run tools → loop; cancellation; background memory extraction | `loop.ts`, `context.ts`, `tools.ts` |
| `llm-client/` | LLM provider abstraction (one interface, one implementation today) | `client.ts`, `groq-client.ts` |
| `ui/` | Everything the terminal displays: chat, activity feed, dialogs, markdown, status/input bars, command menu | `index.tsx`, `terminal.ts`, `markdown.tsx` |
| top-level `src/*.ts` | Shared infrastructure + entry point | `logger.ts`, `paths.ts`, `telemetry.ts`, `main.ts` |

---

## 6. Storage is pinned to the repo root

All runtime-written data lives in the `nightCode` root folder — never relative to
the launch directory. `src/paths.ts` derives the root from the module's own location
(`import.meta.dirname`), so it is correct no matter where the CLI process is started
from (this was the fix for stray `memory/`/`logs/` copies appearing in `packages/cli/`).

| Destination | Path | Written by |
|---|---|---|
| Semantic memory | `<root>/memory/semantic.json` | `SemanticMemoryManager` |
| Procedural memory | `<root>/memory/procedural.md` | `ProceduralMemoryManager` |
| Episodic memory | `<root>/memory/episodic/events.jsonl` | `EpisodicMemoryManager` |
| Combined log | `<root>/logs/combined.log` (5 MB × 5, rotated) | `logger.ts` |
| Error log | `<root>/logs/error.log` (warn+, 5 MB × 5) | `logger.ts` |
| Slash commands | `<root>/commands/*.md` | `CommandRegistry.loadFromDir` (called from `main.ts` with `join(PROJECT_ROOT, "commands")`) |

Both `memory/` and `logs/` are gitignored; they are created on first run.

---

## 7. Slash commands

`commands/*.md` at the repo root are markdown templates with optional YAML
frontmatter (`description`, `allowed-tools`, `argument-hint`). The registry
(`src/agent/commands.ts`) loads them and `resolveSlashCommand` substitutes every
`$ARGUMENTS` occurrence with the user's argument string; the resolved prompt is what
the model sees, while the raw `/command` input stays in message history.

---

## 8. Self-checks (`*.check.ts` / `*.check.tsx`)

Convention: **a check file lives next to the code it tests** and is run directly:

```bash
bun run packages/cli/src/agent/activity.check.ts
bun run packages/cli/src/ui/scroll.check.tsx
```

- `src/agent/*.check.ts` — loop, cancellation, commands, tools, subagent behavior
- `src/llm-client/groq-client.check.ts` — error-code extraction
- `src/ui/*.check.tsx` — markdown rendering, scroll behavior, session UX, narrow-width layout

Checks use plain `node:assert` (or `@opentui/react/test-utils` for the UI ones) —
no test framework. They are deliberately standalone: they are never imported by
application code (which is why `find … -name '*.check.*'` lists them as unreferenced).

---

## 9. Rules of thumb for extending

- **New agent behavior** → `src/agent/`, keep the check beside it.
- **New tool** → add to `src/agent/tools.ts` and register it in `main.ts`.
- **New UI** → `src/ui/`; reach into `agent/` for types only (no agent → ui imports).
- **New runtime data** → pin it to `PROJECT_ROOT` via `src/paths.ts`; never use `process.cwd()` for storage.
- **Don't** create `utils/`/`helpers/`/`misc/` dumping grounds — group by responsibility.

---

## 10. Related docs

- `docs/agent-event-flow.md` — AgentEvent pipeline (types → loop → UI)
- `docs/cancel-latency-postmortem.md` — cancellation latency fix
- `docs/error-recovery.md` — tool failure signaling + concise error summaries
