# Streaming (Pi-style)

NightCode renders the assistant's reply **live**, token-by-token, as the model
generates it — the same incremental UX the [Pi coding
agent](https://github.com/earendil-works/pi) ships. The provider layer already
normalized every transport's wire stream into one event format; this doc
explains the pipeline from the provider API all the way to the terminal, and
what is and isn't streamed.

---

## The pipeline

```
Provider API (SSE / event-stream)
        │  normalized per transport
        ▼
  LLMProvider.stream()  →  LLMEvent*            (llm-client/)
        │
        ▼
  AgentLoop iteration                            (agent/loop.ts)
        │  forwardTextDeltas(): text_delta events are
        │  forwarded to onEvent live, everything else
        │  passes through untouched
        │  collectResponse(): reassembles the SAME full
        │  response the old chat() returned
        ▼
  AgentEvent { type: "text_delta", text }  →  Terminal UI (ui/)
        │
        ▼
  App's streaming bubble — assistant text types out live,
  then becomes the stored message when the run resolves
```

Three moving parts:

1. **`llm-client/` — normalized events.** Every adapter
   (`openai-compatible`, `anthropic`, `google`, `azure`, `vertex`, `bedrock`)
   emits one `LLMEvent` format: `text_delta`, `reasoning_delta`,
   `tool_call_start/delta/end`, `usage`, `finish`, `error`. Nothing below the
   adapter knows what provider is streaming.

2. **`agent/loop.ts` — stream consumption.** Each ReAct iteration now calls
   `this.llm.stream(context, signal)` instead of `chat()`. A small tee
   (`forwardTextDeltas`) forwards `text_delta` and `reasoning_delta` events to
   the UI **as they arrive**, while `collectResponse` (unchanged, in
   `llm-client/stream.ts`) consumes the same stream to rebuild the full
   response: text and reasoning are accumulated, tool calls are assembled by
   index (and parsed with a `ToolCallingError` on malformed arguments), and a
   `tool_calls` response wins when any tool call was made. History storage,
   the tool-call flow, and cancellation semantics are byte-for-byte the same
   as before.

3. **`ui/index.tsx` — live rendering.** A `text_delta` event creates (or
   appends to) a **streaming bubble** rendered in exactly the slot the final
   message will occupy. When `execute()` resolves, the stored message
   replaces the bubble (`setStreaming(null)` + `push("assistant", response)`
   in the same batch — no flicker, no duplication). On error or cancel the
   partially-streamed bubble is discarded.

## What's streamed vs. normalized-but-unrendered

| Event | Streamed to the UI? |
|---|---|
| `text_delta` | ✅ Rendered live as markdown in the assistant bubble |
| `reasoning_delta` | ✅ Rendered live in a dimmed `💭 thinking` panel (capped at 12k chars), discarded when the run completes |
| `tool_call_start/delta/end` | ⏳ Tools already appear live in the activity feed (`tool_start`/`tool_end`); per-argument typing is not shown |
| `usage` / `finish` | Consumed by `collectResponse`; not displayed |
| `error` | Thrown through the stream; surfaced as an Error row |

Every provider maps its own thinking format into `reasoning_delta`: OpenAI
(`reasoning_content`), Anthropic (`thinking_delta`), Gemini (thinking parts),
and Bedrock (Converse `reasoningContent` deltas — e.g. Nova / Claude thinking).

Streaming is **display-only**: the backend still stores one complete
assistant message per final answer, so history, summarization, and memory
extraction are unaffected. The thinking panel is likewise display-only —
reasoning is never stored in history.

## Semantics preserved

- **Cancellation** — the transport's abort watchdog rejects the in-flight
  stream with `CancelledError`; the loop's `throwIfAborted` boundaries are
  unchanged, so aborts still settle in ~ms and never retry.
- **Mid-stream failures** — a provider error thrown by the generator
  propagates exactly as a failed `chat()` did.
- **Backward compatibility** — `chat()` still exists on every provider (it's
  implemented as "consume the stream") and is used for context summarization
  and memory extraction. The `ChatLLM` interface gained `stream()`; the
  `ProviderRouter` already had it.
- **Test stubs** — check files implement `stream()` by delegating to their
  stub `chat()` via `eventsFromResponse` (a tiny response→events converter in
  `llm-client/stream.ts`), so the loop exercises the real streaming path in
  every check.

## Verification

- `agent/activity.check.ts` — drives a real `AgentLoop` and asserts that
  `text_delta` events reach the UI and that concatenating them reassembles
  the final answer.
- `llm-client/stream.check.ts` — SSE parsing and `collectResponse` event
  normalization.
- `llm-client/transports.check.ts` — each provider transport's stream is
  exercised against mock servers.

```bash
bun packages/cli/src/agent/activity.check.ts
bun packages/cli/src/llm-client/stream.check.ts
```
