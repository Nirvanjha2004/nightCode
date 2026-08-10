# AgentEvent Flow — End-to-End Trace

This document traces the full `AgentEvent` pipeline: type definition → emission in the agent loop → consumption in the React UI → final rendering.

---

## 1. Type Definition

**File:** `packages/cli/src/agent/types.ts` (lines 127–135)

Four display-only event variants. These are **never stored in message history**; they are pure progress streaming for the terminal UI.

```ts
type AgentEvent =
  | { type: "stage";     name: string }                                          // background pipeline steps
  | { type: "iteration"; n: number; max: number }                                 // ReAct loop counter
  | { type: "tool_start"; toolName: string; argsPreview: string }                 // before tool.exec
  | { type: "tool_end";   toolName: string; ok: boolean; durationMs: number;      // after tool.exec
                           resultPreview: string };
```

### Preview size caps (in `loop.ts`)

To prevent a multi-megabyte bash log from being round-tripped through React state, the loop trims before emitting:

| Cap | Value | Location |
|-----|-------|----------|
| `PREVIEW_ARGS_MAX`   | 100 chars                   | `loop.ts:47` |
| `PREVIEW_RESULT_MAX` | 400 chars / 5 lines (head)  | `loop.ts:48-49` |

- For `bash` the command string itself is shown (not its JSON wrapper).
- Result preview scans only the first `PREVIEW_RESULT_MAX + 5000` bytes of the raw tool output, keeping the first 5 lines and appending a `… (N more lines)` or `… (output truncated)` marker.

---

## 2. Emission — AgentLoop.execute()

**File:** `packages/cli/src/agent/loop.ts`

All events are fired via the optional callback:

```ts
options?.onEvent?.({ type, ...payload });
```

### 5 fire points

| # | Line | Event | When |
|---|------|-------|------|
| **A** | `loop.ts:138`    | `{ type: "stage", name: "memory" }`  | Start of every user turn, **before** `buildMemoryContext()` runs |
| **B** | `loop.ts:151`    | `{ type: "iteration", n, max }`      | At the **top** of each ReAct for-loop iteration (1..maxIterations) |
| **C** | `loop.ts:327`    | `{ type: "tool_start", ... }`        | **Right before** `tool.exec()` — but **after** any HITL confirmation has passed |
| **D** | `loop.ts:359`    | `{ type: "tool_end", ok, ... }`      | **After** every tool path: success / exception / user-rejected / tool-not-found |
| **E** | `loop.ts:427`    | `{ type: "stage", name: "extract" }` | Final text answer was received; fire-and-forget memory extraction is starting |

### Key behavioural notes

- `tool_start` is intentionally emitted **after** the confirm-prompt resolves. A rejected destructive operation therefore never shows a "started" row; the user only sees the reject result in the next loop iteration's thinking or text.
- `tool_end` always emits regardless of success so the live-row state in the UI is cleared even on crashes.
- The "extract" stage event fires inside `saveMemoryAsync()` which is never awaited — it may therefore arrive in the UI **after** the final assistant bubble has already been pushed. This is correct: memory extraction is a background pass and should never block the response.

---

## 3. Consumption — App.handleAgentEvent()

**File:** `packages/cli/src/index.tsx`

### Hookup

```ts
// index.tsx:314
agentLoop.execute(sessionId, trimmed, {
    confirmHook,
    onEvent: handleAgentEvent,     // ← callback wired
});
```

### Handler logic (`index.tsx:256-267`)

```
event.type === "tool_start"  → setLiveTool({...startedAt: Date.now()})   (just the live row — NOT appended to activity[])
event.type === "tool_end"    → setLiveTool(null) + push to activity[]
stage / iteration            → push straight to activity[]
```

### Live tool timer (`index.tsx:248-252`)

A `useEffect` watches `liveTool`. While truthy it runs a 1-second `setInterval` that refreshes `liveElapsed = floor((now - startedAt)/1000)`, giving the user a running count under the yellow arrow row. When the tool clears, the interval is cleaned up.

### Error path (`index.tsx:322`)

If the whole `execute()` promise throws (e.g. max iterations reached, or Groq 500), `setLiveTool(null)` runs in the catch block so an aborted run can never leave a ghost yellow "running…" row stuck permanently in the feed.

---

## 4. Rendering — React Component Chain

**File:** `packages/cli/src/index.tsx`

The activity feed lives **inside the messages scrollbox**, rendered **after** all finished message bubbles and **before** the standalone `ThinkingIndicator`. This keeps the user's eye anchored in the same scroll region they already watch for replies.

```
<scrollbox>                                    ← the messages area
  ├─ {messages.map} → <MessageBubble />        ← You / NightCode / Error cards
  └─ {activity.length > 0 && (
        <box paddingX={2}>                     ← activity feed container
          ├─ activity.map((event, i) => {
          │     "stage"     → <StageRow />     ← "· loading memory"
          │     "iteration" → <IterationRow /> ← "· iter 2/10"
          │     "tool_end"  → <ToolEndRow />   ← "✓ grep · 0.3s" + result preview
          │  })
          └─ {liveTool && (                    ← yellow live in-progress row
                →  grep src/**  ·  3s   )}
       )}
  └─ {loading && !liveTool → <ThinkingIndicator />}   ← animated dots fallback
</scrollbox>
```

### Visual tokens

| Component | Snippet | Style |
|-----------|---------|-------|
| `StageRow` (`index.tsx:133`)       | `· loading memory`     | overlay1, dim |
| `IterationRow` (`index.tsx:141`)   | `· iter 2/10`         | overlay1, dim |
| `ToolEndRow` success               | `✓ grep · 0.3s`       | green, result preview dimmed below |
| `ToolEndRow` failure               | `✗ rm · 0.1s`         | red, **bold** label |
| Live inline row                    | `→ grep src · 3s`     | yellow, dim, `→` arrow prefix |
| `ThinkingIndicator`                | `Thinking...`         | yellow, animated dots (only when no live tool) |

---

## 5. Full Flow Diagram

```
User types query + presses Enter
  │
  ▼
handleSubmit (index.tsx:305)
  ├─ push user MessageBubble
  ├─ setLoading(true)
  └─ agentLoop.execute(sessionId, text, { confirmHook, onEvent: handleAgentEvent })
        │
        ▼
      AgentLoop.execute
        │
        ├─ [A] onEvent(stage "memory")
        │     └─ handleAgentEvent → activity[] = [StageRow "· loading memory"]
        │
        ├─ buildMemoryContext(...)
        │
        └─ for iter = 1..maxIterations:
             │
             ├─ [B] onEvent(iteration n/m)
             │     └─ activity[] = [..., IterationRow "· iter 2/10"]
             │
             ├─ ContextBuilder.build(...) → Groq context
             ├─ llm.chat(context)          → LLM response
             │
             ├─ response.type === "text"
             │     ├─ store assistant message
             │     ├─ [E] saveMemoryAsync → onEvent(stage "extract")
             │     │    └─ activity[] = [..., StageRow "· saving memories"]
             │     └─ return text  ───────────────────┐
             │                                         │
             └─ response.type === "tool_calls"        │
                  └─ for each toolCall:               │
                       ├─ (confirmHook if destructive)│
                       │                              │
                       ├─ [C] onEvent(tool_start)     │
                       │     └─ setLiveTool →         │
                       │        yellow live row:      │
                       │        "→ grep src · 0s"     │
                       │        + 1s elapsed ticker   │
                       │                              │
                       ├─ await tool.exec(args)       │
                       │                              │
                       └─ [D] onEvent(tool_end) ◄─────┘
                              ├─ setLiveTool(null)     │
                              │   (clears yellow row)  │
                              └─ push ToolEndRow ──────┤
                                 "✓/✗ tool · N.s"      │
                                 + 5-line preview      │
                                                        │
  ◄────────────────────────  return text  ─────────────┘
  │
  ▼
push assistant MessageBubble
setLoading(false)
scrollbox sticky-scrolls to the new content
```

---

## 6. One Deliberate Design Choice

`tool_start` events are intentionally **NOT appended to `activity[]`** — compare the early returns at `index.tsx:257-260`.

If both were pushed you would see:

```
→ grep src · 0s              ← tool_start (stale after tool ends)
✓ grep · 0.3s                ← tool_end   (final)
```

…which duplicates every tool row and makes the feed noisy. Instead:

- `tool_start` → **only** powers the transient `liveTool` state (the yellow arrow row with the ticking counter)
- `tool_end` → **only** writes the permanent, final row into `activity[]`

The result is a clean visual transition: *yellow running counter* → *green/red finalised result*, zero duplication and zero ghost rows.
