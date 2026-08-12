# System Prompt & Tool Surface (Pi-style)

NightCode's system prompt and the tool surface the model sees follow the
**Pi coding agent** ([earendil-works/pi](https://github.com/earendil-works/pi))
shape. Pi is a top-ranked terminal-bench agent whose score comes largely from
two things: frontier-model access and **keeping the model's context clean**.
A bloated harness — huge system prompts, tool zoos, hidden injections —
burns context headroom and causes truncation failures. This doc describes how
NightCode implements the lean-prompt / lean-surface design, and how to change it.

The rationale and the benchmark-driver comparison live in README §5.

---

## The system prompt

Composed per-turn in `packages/cli/src/agent/context.ts` as:

```
You are an expert coding assistant operating inside NightCode, a terminal-based
coding agent harness. You help users by reading files, executing commands,
editing code, and writing new files.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Never assume file contents, paths, or project structure — investigate first, then modify
- Prefer edit over write when modifying existing files
- Use git status and git diff to verify changes before declaring success
- Run the smallest relevant test or build to verify your work
- Never read or modify files inside the memory/ directory, and never try to store memories manually
- Destructive operations require user confirmation — never bypass it

Available tools:
- read: Read the full text contents of a file. Use before editing or inspecting any file.
- write: Create a new file, or overwrite an existing one (replaces the ENTIRE file — prefer edit for changes).
- ... (one line per visible tool)

Current working directory: /absolute/path/to/cwd

## Known facts / ## Learned rules / ## Relevant past events   ← memory (appended when present)
```

Key properties:

- **~700 tokens** instead of the previous ~2,500-token static prompt.
- **`Available tools:` is built dynamically from the actual filtered tool
  surface** (`TOOL_SNIPPETS`), so the prompt and the native tool-calling
  definitions the model receives can never drift apart.
- **`Current working directory` prints `process.cwd()`** — the directory
  `read`/`write`/`bash` actually resolve relative paths against. Never claim
  `PROJECT_ROOT` here (runtime files are anchored to the root, but tools run
  against the launch directory).
- **Memory context is still appended** (as "Known facts / Learned rules /
  Relevant past events"). This is a deliberate NightCode feature — see
  [Memory injection](#memory-injection) below.

## The model-visible tool surface

NightCode registers **15 tools**, but the model only sees **9**:

| Visible (advertised to the model) | Hidden (registered, executable, not advertised) |
|---|---|
| `read` · `write` · `edit` · `bash` · `grep` · `find` · `ls` — **Pi's default 7** | `append` · `delete` · `mkdir` · `glob` · `rename` · `copy` |
| `todoWrite` — task planning | |
| `spawn_subagent` — subagent delegation | |

The seven Pi tools are the lean core; `todoWrite` and `spawn_subagent` are
NightCode features that stay on the surface. The other six remain **fully
registered and executable** — they're just never advertised to the model, so a
context-window-token-starved tool zoo doesn't degrade reasoning.

Hidden tools are still reachable where scopes explicitly need them:

- **Slash commands** (`commands/*.md` `allowed-tools`) intersect with the
  surface — e.g. `/commit` scopes to `bash`, `/review` to `bash, read, grep`.
  If a scope asks for a hidden tool, it is dropped with a `logger.debug`
  message (a "0 tools" context is diagnosable, not mysterious).
- **Subagents** (`spawn_subagent`) get their own scoped surface via
  `allowedTools` — e.g. `["read", "grep"]` for investigation.

## Customizing the surface

All of it lives at the top of `packages/cli/src/agent/context.ts`:

- **`VISIBLE_TOOLS`** — the `Set` of tool names advertised to the model.
  Add a name here to surface an existing tool; remove one to hide it.
- **`TOOL_SNIPPETS`** — the one-line `Available tools:` snippet per visible
  tool. Fallback: the tool's full `description` if a name has no snippet.
- **`baseSystemPrompt`** — the identity line + guideline bullets.

The native tool-calling definitions (sent via the provider API) always carry
the tool's **full** `description` from `tools.ts`; the prompt snippets are
deliberately shorter, exactly as Pi does.

## Memory injection

By design NightCode still appends the full semantic/procedural/episodic memory
dump to every system prompt. This is the one remaining "bloat" lever (see
README §5.2 *Progressive disclosure* and §6.1 roadmap item #3): the next step,
when you want it, is to stop injecting the dump and instead expose memory as
files or per-query slices. The guard that keeps the `memory/` tree off-limits
to agent tools is unchanged.

## Interactions with the rest of the system

- **`allowedTools` scoping** (subagents, slash commands) is applied **first**
  (`listFiltered`), then intersected with `VISIBLE_TOOLS`. Scoping can only
  shrink the surface, never grow it.
- **Provider transports** are untouched — the prompt string is passed through
  to whatever adapter is active, and the OpenAI-compatible transport's
  `no-tools` repair retry appends to it harmlessly.
- **Context compression** (LLM summarization past ~75% of the model's window)
  is independent of the prompt — it summarizes old *messages*, not the prompt.

## Verification

`packages/cli/src/agent/context.check.ts` asserts the contract:

- exactly the 9 visible tools in the tool list, hidden tools absent from both
  the list and the prompt;
- the prompt's `Available tools:` mirrors the actual surface;
- memory context is still injected; the prompt stays compact and the old
  verbose sections are gone;
- `allowedTools` scoping still applies on top of the surface.

```bash
bun packages/cli/src/agent/context.check.ts
```
