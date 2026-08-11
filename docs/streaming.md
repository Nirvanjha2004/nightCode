# Streaming Responses — End-to-End Trace

This document traces the token-streaming feature: interface contract → provider stream consumption → `text_delta` AgentEvent → React UI buffering → progressive render. It pairs with `agent-event-flow.md` (the other progress events) and `cancel-latency-postmortem.md` (the abort watchdog this feature reuses).

---

## 1. Why

Before this change, `GroqClient.chat()` awaited the **entire** completion. The user saw `Thinking...` and then the whole answer arrive at once. Now the request is sent with `stream: true`, the provider returns an SSE stream, and each chunk's `delta.content` fragment is forwarded up the stack so the answer grows in place.

Three hard constraints shaped the design:

1. **History/context/logging stay unchanged.** The stored assistant message and the returned `LLMResponse` carry the **full** text; streaming only adds a *display* path.
2. **Cancellation stays instant.** The abort watchdog from the cancel-latency postmortem is extended to race *every chunk read*, so an abort mid-generation still settles in ~ms.
3. **No per-token React renders.** The UI buffers deltas in a ref and flushes to state at 50 ms, capping re-renders regardless of stream speed.

---

## 2. Interface contract — `packages/cli/src/llm-client/client.ts`

```ts
export interface LLMClient {
    chat(
        context: ContextType,
        signal?: AbortSignal,
        /** Called with each streamed text fragment as it is generated (may be omitted for non-streaming clients). */
        onDelta?: (text: string) => void
    ): Promise<LLMResponse>;
}
```

- `onDelta` is **optional** — non-streaming clients and callers that don't care are unaffected.
- It fires with each **non-empty** text fragment as it arrives. Tool-call responses never emit text deltas.
- The return value is unchanged, so the loop's `throwIfAborted`, history writes and memory extraction all keep working verbatim.

---

## 3. Provider — `packages/cli/src/llm-client/groq-client.ts`

### 3.1 Threading `onDelta` through every path

`chat()` (`groq-client.ts:45-47`) accepts `onDelta` and forwards it to **every** `callGroq` invocation:

| Path | Line | Notes |
|------|------|-------|
| Primary call | `groq-client.ts:53` | `callGroq(context, "auto", signal, onDelta)` |
| `tool_use_failed` repair retry | `groq-client.ts:91` | Repair prompt; re-streams the corrected generation to the same bubble |
| No-tools text-only fallback | `groq-client.ts:116` | Last resort after two invalid tool-call generations |

Every retry re-streams — the UI bubble simply keeps growing across the retry.

### 3.2 `stream: true` + the abort watchdog

The request now sends `stream: true` (`groq-client.ts:190`) and `create()` resolves to the SDK's `Stream` object instead of a completed response. The existing abort watchdog (`groq-client.ts:160-176`) is reused and races **two** places:

```ts
const stream = await Promise.race([createPromise, abortPromise]);   // abort before/while the stream opens
...
const { done, value } = await Promise.race([iterator.next(), abortPromise]);  // abort mid-stream
```

The second race is the new part: without it, an abort while a chunk read is in flight would wait on a stalled `next()` — exactly the 7+ second hang the watchdog was built to prevent.

### 3.3 Chunk consumption

```
for each chunk from the stream:
    delta = value.choices?.[0]?.delta

    if delta.content            → fullContent += content;  onDelta(content)
    if delta.tool_calls         → reassemble fragments by tc.index (append arguments)
    if value.x_groq.usage       → llm span attributes (prompt / completion / total tokens)

after the stream ends:
    toolCallFragments.length > 0 → return { type: "tool_calls", toolCalls }   (reassembled, JSON.parsed)
    !fullContent                 → throw Error("Groq returned no content.")   (never a silent empty response)
    else                         → return { type: "text", content: fullContent }  (FULL text)
```

| Concern | Behavior |
|---|---|
| Empty chunks | Skipped — `delta.content` is falsy, so no accumulation and no `onDelta`. A `content: null` or `{}` delta never produces a gap in the bubble. |
| Text deltas | Only non-empty fragments reach `onDelta` (`groq-client.ts:268-269`). |
| Tool-call fragments | Split across chunks and keyed by `tc.index`; `id` / `name` / `arguments` are reassembled positionally (`groq-client.ts:273-283`), then parsed into the **same** `ToolCall[]` shape the non-streaming path returned. |
| Token usage | Groq sends usage in the **final streamed chunk** as `x_groq.usage` → `llm.*_tokens` span attributes (`groq-client.ts:285-289`). This replaces the non-stream `response.usage` read. |
| Empty stream (e.g. a run cut off by `length`) | `Error("Groq returned no content.")` (`groq-client.ts:341-343`) — an error, never a silent empty bubble. |
| Return shape | Identical to before: full text for `type: "text"`, reassembled calls for `type: "tool_calls"`. |

---

## 4. Event type — `packages/cli/src/agent/types.ts`

New `AgentEvent` variant (`types.ts:156`):

```ts
| { type: "text_delta"; delta: string }
```

Display-only, **never stored in message history** — the same rule as `stage` / `iteration` / `tool_*`.

---

## 5. Loop emission — `packages/cli/src/agent/loop.ts`

The loop's only job is bridging `onDelta` → `onEvent` (`loop.ts:226-237`):

```ts
const response = await this.llm.chat(
    context,
    options?.signal,
    (delta: string) => {
        options?.onEvent?.({ type: "text_delta", delta });
    }
);
```

- The returned `LLMResponse` still carries the **full** text, so history storage, context build and logging are untouched.
- Because `onDelta` only fires on the text path, tool-call turns emit no `text_delta` events at all.

---

## 6. UI consumption — `packages/cli/src/index.tsx`

### 6.1 State (`index.tsx:240-242`)

```ts
const [streaming, setStreaming] = useState(false);
const [streamText, setStreamText] = useState("");
const streamRef = useRef("");
```

### 6.2 Buffering + 50 ms flush (`index.tsx:275-279`)

Deltas arrive at token speed, but React must not re-render per token:

```ts
useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setStreamText(streamRef.current), 50);
    return () => clearInterval(t);
}, [streaming]);
```

- `handleAgentEvent` appends every `text_delta` to `streamRef.current` and **returns early** (`index.tsx:298-303`) — streamed text is *never* routed to the activity feed.
- The 50 ms timer copies the ref into state, capping re-renders at ~20/s regardless of stream speed. Between flushes the buffer just accumulates in the ref.

### 6.3 Render — the live bubble (`index.tsx:505-508`)

```tsx
{streaming && streamText && (
    <box key="streaming" marginBottom={1}>
        <MessageBubble msg={{ id: "streaming", role: "assistant", content: streamText }} />
    </box>
)}
```

A NightCode bubble that **grows in place**, rendered after the finished message bubbles and before the activity feed.

### 6.4 Lifecycle

| Phase | Code |
|---|---|
| **Submit** | `streamRef.current = ""; setStreamText(""); setStreaming(true);` — a fresh run starts a fresh streamed response. |
| **Success** | `push("assistant", response)` (the full text) + `setStreaming(false)` — the live bubble is replaced by the permanent one, zero duplication. |
| **Cancel** | `setStreaming(false)` in the `AbortError` branch of the catch — the partial bubble disappears and `⚠ Cancelled` renders. |
| **Error** | `setStreaming(false)` in the error branch — the partial bubble is dropped, the error bubble renders. |

---

## 7. Edge cases

| Scenario | Behavior |
|---|---|
| Fast stream | 50 ms flush caps re-renders; the ref accumulates between flushes. |
| Empty / `null`-content chunks | Skipped — no empty gaps in the bubble. |
| Tool-call turn | No deltas emitted → the live bubble never appears for that `llm.chat`. |
| Abort mid-stream | The watchdog races `iterator.next()` → `AbortError` in ~ms; bubble torn down, `⚠ Cancelled` shown. |
| `tool_use_failed` repair / no-tools fallback | `onDelta` threads through both retries — the bubble keeps streaming the corrected generation. |
| Empty stream (length cutoff) | `Groq returned no content.` surfaces as an error bubble via the normal catch path. |
| Final response | Full text pushed as a permanent bubble, live bubble removed — no duplication. |

---

## 8. Validation — `packages/cli/src/llm-client/groq-client.check.ts`

Tests 5–8 lock in the streaming contract:

| # | Assertion |
|---|-----------|
| 5 | Text chunks accumulate into the FULL response **and** only non-empty deltas are emitted: `deltas == ["Hel", "lo ", "world"]` |
| 6 | Index-keyed tool-call fragments reassemble into the same `ToolCall[]` shape (`[{ id: "t1", name: "read", args: { file: "a.ts" } }]`) |
| 7 | An all-empty stream rejects with `Groq returned no content.` |
| 8 | Abort mid-stream (a `next()` that never resolves, via `hangingStream()`) rejects with `AbortError` — the watchdog wins |

Run: `bun packages/cli/src/llm-client/groq-client.check.ts`
Typecheck: `bunx tsc --noEmit -p packages/cli/tsconfig.json`

---

## 9. Flow diagram

```
User submits
  │
  ├─ streamRef.current = ""; setStreamText(""); setStreaming(true)
  │
  ▼
AgentLoop.execute
  └─ llm.chat(context, signal, onDelta)
        │
        ▼
      GroqClient.callGroq  — stream: true
        ├─ await race(createPromise, watchdog)            ← abort before stream opens
        ├─ for each chunk: await race(iterator.next(), watchdog)   ← abort mid-stream
        │     ├─ delta.content   → fullContent += c; onDelta(c)
        │     │                        └─ loop → onEvent({ type: "text_delta", delta: c })
        │     │                             └─ UI → streamRef.current += c
        │     │                                  └─ 50 ms timer → setStreamText(ref)
        │     │                                       └─ <MessageBubble> grows in place
        │     ├─ delta.tool_calls → fragments[idx] reassembled
        │     └─ x_groq.usage     → llm span attributes
        └─ return LLMResponse  (FULL text | toolCalls)
  │
  ├─ type === "text"      → push("assistant", response); setStreaming(false)
  └─ type === "tool_calls" → tools run (no deltas) → next iteration streams again
```

---

## 10. Files touched

| File | Change |
|---|---|
| `packages/cli/src/llm-client/client.ts` | `LLMClient.chat` gains the optional `onDelta` third parameter |
| `packages/cli/src/llm-client/groq-client.ts` | `stream: true`; chunk consumption; `onDelta` threaded through all retry paths; watchdog extended to per-chunk reads; `x_groq.usage`; empty-stream guard |
| `packages/cli/src/agent/types.ts` | New `{ type: "text_delta"; delta: string }` event variant |
| `packages/cli/src/agent/loop.ts` | Bridges `onDelta` → `onEvent({ type: "text_delta", delta })` |
| `packages/cli/src/index.tsx` | Streaming state + ref buffering + 50 ms flush + live bubble render + teardown on success/cancel/error |
| `packages/cli/src/llm-client/groq-client.check.ts` | Tests 5–8: deltas, tool-call reassembly, empty stream, mid-stream abort |
