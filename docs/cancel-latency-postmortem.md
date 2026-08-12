# Postmortem — 8-second cancellation latency (Ctrl+C / Esc)

**Severity:** Medium (UX) — cancellation *worked*, but "⚠ Cancelled" took 8–10 s to appear.
**Environment:** NightCode CLI on Windows, running under Bun (`bun run --watch`), `groq-sdk@1.4.0`, model `qwen/qwen3.6-27b`.
**Outcome:** Root cause was in **Bun's fetch runtime**, not our code. Fixed with an **abort watchdog** that forces the rejection at the layer we control.

---

## 1. The symptom

> "the ctrl + c and esc button are working exactly fine, but there is huge latency — when i press either of these, it takes 8-10 seconds to get cancelled (or show cancelled)."

The keypress itself was fine. The agent eventually stopped. But the UI showed nothing for ~8 s. We needed to find *which hop* between the keypress and the "⚠ Cancelled" render was eating the time.

---

## 2. How cancellation is *supposed* to work

The cancel path is a single `AbortController` created per run in the UI and threaded through everything:

```
User presses Esc/Ctrl+C
  └─ useKeyboard handler  (packages/cli/src/ui/index.tsx)
      └─ cancelRun()  →  controller.abort()
          └─ AgentLoop.execute()  observes signal at checkpoints (throwIfAborted)
              └─ GroqClient.chat()  →  groq-sdk  →  fetch(url, { signal })
                  └─ loop throws CancelledError → execute() rejects
                      └─ UI catch → handleAgentEvent({ type: "cancelled" })
                          └─ "⚠ Cancelled" renders
```

The loop's `throwIfAborted` guard:

```ts
// packages/cli/src/agent/loop.ts
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new CancelledError();
    }
}
```

`CancelledError` is named `"AbortError"` so callers detect cancellation via `err.name === "AbortError"` uniformly.

---

## 3. Step 1 — Instrumentation: the `[CancelLatency]` trace

We had no visibility into where the seconds went, so we added an end-to-end tracer: the UI records the exact moment `abort()` is called, and every downstream observer logs **elapsed-ms-since-abort** at its checkpoint. A gap between two consecutive lines = that hop is where the time went.

New module — `packages/cli/src/agent/cancel-latency.ts`:

```ts
import { logger } from "../logger";

const abortTs = new WeakMap<AbortSignal, number>();

/** Record the wall-clock time an abort fired. Called by the UI right before abort(). */
export function recordAbortTs(signal: AbortSignal): void {
    if (!abortTs.has(signal)) {
        abortTs.set(signal, Date.now());
        logger.debug(`[CancelLatency] abort recorded (t0=${Date.now()})`);
    }
}

/** Milliseconds elapsed since the recorded abort, or undefined if never recorded. */
export function cancelLatencyMs(signal?: AbortSignal): number | undefined {
    if (!signal) return undefined;
    const ts = abortTs.get(signal);
    return ts === undefined ? undefined : Date.now() - ts;
}

/**
 * Log how long after the abort this checkpoint was reached. No-op unless the
 * abort was recorded via recordAbortTs (same AbortSignal instance).
 */
export function logCancelLatency(
    where: string,
    signal?: AbortSignal,
    extra: Record<string, unknown> = {}
): void {
    const ms = cancelLatencyMs(signal);
    if (ms === undefined) return;
    logger.info(`[CancelLatency] ${where} — ${ms}ms since abort`, extra);
}
```

A `WeakMap` keyed by `AbortSignal` means the trace is **silent on every normal run** — it only activates once the UI records an abort, and the entries are GC'd with their controllers.

### Trace points wired in

**UI — t0 and the final render** (`packages/cli/src/ui/index.tsx`):

```ts
const controller = abortRef.current;
if (controller) {
    recordAbortTs(controller.signal);
    logCancelLatency("keypress handled → abort() called", controller.signal);
    controller.abort();
} else {
    logger.info("[CancelLatency] cancelRun: no active run controller");
}
```

and in `handleSubmit`'s catch, where the run finally rejects:

```ts
if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
    logCancelLatency("execute() rejected → UI shows ⚠ Cancelled", controller.signal);
    logger.info("[UI] Agent run cancelled");
    handleAgentEvent({ type: "cancelled" });
} else { ... }
```

**AgentLoop** (`packages/cli/src/agent/loop.ts`) — one line at each phase the loop passes through:

```ts
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        logCancelLatency("loop throwIfAborted → CancelledError thrown", signal);
        throw new CancelledError();
    }
}
```

```ts
// after the memory-context phase (the Jina embedding has no signal/timeout —
// a big elapsed here means the abort waited on it):
logCancelLatency("memory context phase complete (embedding returned)", options?.signal);
```

```ts
// after the context build (long-history summarization is also unsignalled):
logCancelLatency("context built", options?.signal);
```

```ts
// after the LLM call resolves:
const response = await this.llm.chat(context, options?.signal);
logCancelLatency("LLM call resolved", options?.signal);
throwIfAborted(options?.signal);
```

```ts
// in execute()'s catch, right before rejecting:
} catch (err) {
    logCancelLatency("execute() rejecting (end of loop path)", options?.signal);
    markSpanError(span, err);
    throw err;
}
```

**GroqClient** (`packages/cli/src/llm-client/groq-client.ts`) — log when the request finally rejects:

```ts
} catch (err: any) {
    if (signal?.aborted) {
        logCancelLatency("LLM request aborted (groq client rejected)", signal);
        throw err;
    }
    ...
}
```

**bash/grep child-kill** (`packages/cli/src/agent/tools.ts`) — log when the kill fires and when the child settles:

```ts
const onAbort = () => {
    logCancelLatency("bash abort listener fired → killing child tree", signal);
    killProcessTree(child, "SIGTERM");
};
```

```ts
if (signal?.aborted) {
    logCancelLatency("bash exec settled after kill (child tree dead)", signal);
    throw new CancelledError();
}
```

**Jina embedding** (`packages/cli/src/agent/memory/EpisodicMemoryManager.ts`) — always time the embedding, even on failure:

```ts
private async getEmbedding(text: string): Promise<number[]> {
    const embeddingStarted = Date.now();
    try {
        const res = await fetch("https://api.jina.ai/v1/embeddings", { ... });
        if (!res.ok) {
            throw new Error(`Jina embedding failed: ${res.status} ${await res.text()}`);
        }
        const data: any = await res.json();
        return data.data[0].embedding;
    } finally {
        console.log(`[MemoryManager] getEmbedding took ${Date.now() - embeddingStarted}ms`);
    }
}
```

---

## 4. Step 2 — First trace: the keypress is instant, the trace stops at `abort()`

Run #1 — the user pressed Esc while the main loop was awaiting the qwen LLM call (iteration 2):

```
07:39:54.717  [AgentLoop] Starting execution — session=a928f4c9...
07:39:54.718  [Harness] Building memory context
07:39:54.720  [AgentLoop] Memory context built (len=43)            ← 2ms, embedding NOT the problem
07:39:54.726  [GroqClient] Chat request | model=qwen | messages=1 | tools=15
07:39:55.525  [Tool:spawn_subagent] started
07:39:55.526  [AgentLoop] Starting execution — session=436ba20b...  ← subagent (llama) runs git status
07:39:56.794  [Tool:spawn_subagent] completed in 1269ms
07:39:56.797  [GroqClient] Chat request | model=qwen | messages=3 | tools=15   ← main iter-2 LLM call
07:40:01.586  [UI] Cancelling active agent run                                  ← user pressed Esc (4.8s in)
07:40:01.586  [CancelLatency] abort recorded (t0=...)
07:40:01.587  [CancelLatency] keypress handled → abort() called — 0ms since abort
<-- trace ends here; nothing more until the run settles ~8.3s later -->
```

**What this told us:**
- Keypress → `abort()` = **0ms**. Not the problem.
- Memory phase = 2ms, context build = ~4ms, tools done. Not the problem.
- At abort time the loop was sitting in `await this.llm.chat(...)` — a qwen request in flight for 4.8 s.
- The trace went quiet — meaning the LLM promise didn't reject promptly.

---

## 5. Step 3 — Ruling the SDK in or out (probes + source reading)

The top suspect was "the Groq SDK doesn't abort the fetch". We tested that directly with throwaway scripts against the real API key, the **installed** SDK, under Bun:

```ts
const controller = new AbortController();
const p = client.chat.completions.create(
    { model: "llama-3.1-8b-instant", messages: [...], max_tokens: 2048 },
    { signal: controller.signal }
);
setTimeout(() => controller.abort(), 1000);
await p; // measure time from abort() to rejection
```

```
[llama-3.1-8b-instant] rejected ~20ms after abort fired — "Request was aborted."
[qwen/qwen3.6-27b]    rejected ~20ms after abort fired — "Request was aborted."
```

Then the exact app request shape (15 real tools, `tool_choice`, no `max_tokens`, real system prompt extracted from `context.ts`, abort at 1.5 s):

```
[probe] abort EVENT fired at 1515ms
[result] rejected 16ms AFTER abort() fired (1516ms total) — name=Error
```

**The SDK aborts in ~16–20 ms standalone.** We also read the SDK source and confirmed the plumbing is correct:

```js
// groq-sdk/src/client.ts
const req: FinalizedRequestInit = {
    method, headers: reqHeaders,
    ...(options.signal && { signal: options.signal }),   // external signal into the request
    ...
};

async fetchWithTimeout(url, init, ms, controller) {
    const { signal, method, ...options } = init || {};
    const abort = this._makeAbort(controller);           // () => controller.abort()
    if (signal) signal.addEventListener('abort', abort, { once: true });
    ...
    const fetchOptions = { signal: controller.signal, ...options };  // fetch gets the internal signal
    return await this.fetch.call(undefined, url, fetchOptions);
}
```

and the abort check in `makeRequest` is bulletproof — no retry can happen after an abort:

```js
if (response instanceof globalThis.Error) {
    if (options.signal?.aborted) {
        throw new Errors.APIUserAbortError();   // never reaches the retry branch
    }
    ...
}
```

Also ruled out: the SDK's internal timeout is 60 s (the app rejected at 13.1 s — not a timeout), and `span.end()` (OTel) measured **2ms** with the OTLP endpoint unreachable, with no auto-instrumentation registered.

---

## 6. Step 4 — Second trace: the bisect that caught it

We added two surgical lines inside `callGroq` to separate "abort delivered" from "fetch settled":

```ts
// groq-client.ts, inside callGroq, before the request
const onAbortEvent = () => {
    logCancelLatency("SDK abort event delivered to request options", signal);
};
if (signal) {
    if (signal.aborted) onAbortEvent();
    else signal.addEventListener("abort", onAbortEvent, { once: true });
}
```

```ts
// in callGroq's catch, BEFORE span.end()
} catch (err) {
    if (signal?.aborted) {
        logCancelLatency("llm.call fetch rejected (before span.end)", signal);
    }
    markSpanError(llmSpan, err);
    throw err;
}
```

Run #2 (same scenario, abort 7.8 s into the LLM call):

```
07:58:00.307  keypress handled → abort() called — 0ms since abort
07:58:00.309  SDK abort event delivered to request options — 2ms since abort   ← delivered!
07:58:07.611  llm.call fetch rejected (before span.end) — 7304ms since abort    ← the FETCH held it
07:58:07.612  LLM request aborted (groq client rejected) — 7305ms since abort
07:58:07.613  execute() rejecting (end of loop path) — 7306ms since abort
07:58:07.613  execute() rejected → UI shows ⚠ Cancelled — 7306ms since abort
```

**The smoking gun.** The abort event reaches the request options in **2 ms** (so our code and the event loop are fine — the SDK's own listener fires in the same dispatch and calls the internal `controller.abort()`). But the fetch promise does **not** reject for another **7.3 s**.

Supporting evidence: in two independent runs the rejection landed ~13–15 s after the request *started* — i.e., roughly when Groq would have finished generating anyway. The abort only "took effect" at the next socket event, not immediately.

**Root cause: Bun's fetch does not reliably reject an in-flight request when its AbortSignal fires.** Local controlled tests confirmed the behavior is socket-state dependent (abort while waiting for headers = 15 ms; abort while actively reading a chunked body = 2 ms; but an idle HTTPS connection mid-generation = seconds). We cannot patch the runtime — so we fix it at our layer.

---

## 7. Step 5 — The fix: an abort watchdog

`groq-client.ts` `callGroq` now races the SDK request against a watchdog that rejects the **instant** the run's signal fires. Since signal delivery is proven to take ~2 ms, cancellation settles in milliseconds regardless of what Bun's fetch does with the orphaned request:

```ts
const requestPromise = this.client.chat.completions.create({ ... }, { signal });

// ── Abort watchdog ──────────────────────────────────────────────
// Bun's fetch does not reliably reject an in-flight request when its
// AbortSignal fires — measured 7+ seconds of the fetch holding the
// abort while the run's signal fired in 2ms. The SDK cannot fix that,
// so race the request against a watchdog that rejects the INSTANT the
// run's signal fires. Cancellation then settles in ~ms regardless of
// the fetch's behavior; the orphaned request settles in the background
// and is swallowed below.
// ponytail: the orphaned request stays alive until the SDK's 60s
// timeout, holding one socket in the background — bounded and
// user-invisible; the upgrade path is a hard kill, which the SDK
// already partially does by relaying the same signal to the fetch.
requestPromise.catch(() => {}); // never surface the orphaned settle
let onAbort: (() => void) | undefined;
const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
        logCancelLatency("abort watchdog fired → forcing LLM rejection", signal);
        reject(new CancelledError());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
});

let response: Awaited<typeof requestPromise>;
try {
    response = await Promise.race([requestPromise, abortPromise]);
} finally {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
}
```

How it behaves in every path:

| Scenario | Behavior |
|---|---|
| Normal response | `requestPromise` wins the race; listener removed in `finally`; success path unchanged. |
| User aborts | Watchdog rejects with `CancelledError` in ~2 ms; the loop throws; UI shows "⚠ Cancelled" instantly. |
| Orphaned request | The SDK still got the signal (it relays it to its own fetch), so it eventually settles; `requestPromise.catch(() => {})` swallows it — no unhandled rejection. |
| Pre-aborted signal | `if (signal?.aborted) onAbort()` rejects before the request can matter. |
| Real API error | `requestPromise` wins the race with the error; normal error handling unchanged. |
| No signal (subagents-in-tests etc.) | Watchdog never settles; race waits on `requestPromise` only. |

(The signal is still passed to `create()` so the SDK's own abort machinery runs too — the watchdog is a backstop, not a replacement.)

---

## 8. Step 6 — Validation that actually proves the fix

The existing self-check (`packages/cli/src/agent/cancel.check.ts`, run with `bun packages/cli/src/agent/cancel.check.ts`) had test 5 assert the SDK forwards the signal. The old assertion (`/aborted/i` on the message) passed under *both* old and new behavior, so it couldn't prove the fix. We strengthened it with a **timing assertion**: the fake request settles in 1 s, and the rejection must arrive well before that — i.e., the watchdog fired, not the SDK's slow settle:

```ts
inner.chat.completions.create = async (_params: unknown, opts?: { signal?: AbortSignal }) => {
    createCalls++;
    seenSignal = opts?.signal;
    // Settle LATE (1s) — the abort watchdog must reject long before this,
    // proving cancellation does NOT wait on the SDK/fetch to notice the
    // abort (the Bug that caused the 8s cancel latency).
    await new Promise((r) => setTimeout(r, 1000));
    if (opts?.signal?.aborted) throw new Error("Request was aborted.");
    return { choices: [{ message: { content: "ok" } }] };
};
...
const groqPromise = gc.chat(context, groqController.signal);
const abortSentAt = Date.now();
setTimeout(() => groqController.abort(), 20);
await assert.rejects(groqPromise, isAbort, "aborted LLM request rejects with an AbortError");
// The watchdog must win LONG before the fake request's 1s settle — this
// timing assertion is what actually locks in the instant-cancel fix.
const watchdogMs = Date.now() - abortSentAt;
assert.ok(watchdogMs < 500, `watchdog rejected within 500ms of abort (took ${watchdogMs}ms)`);
assert.equal(seenSignal, groqController.signal, "AbortSignal reached the request options");
assert.equal(createCalls, 1, "aborted request is not retried or repaired");
```

Validation results:

```
$ bunx tsc --noEmit -p packages/cli/tsconfig.json     # clean
$ bun packages/cli/src/agent/cancel.check.ts          # PASS — all 6 sections
```

---

## 9. What the trace looks like after the fix

Restart (`bun run dev:cli`), reproduce, and the `[CancelLatency]` lines should read:

```
keypress handled → abort() called — 0ms
SDK abort event delivered to request options — 2ms
abort watchdog fired → forcing LLM rejection — 2ms          ← new
llm.call fetch rejected (before span.end) — 2ms             ← was 7304ms
execute() rejected → UI shows ⚠ Cancelled — 3ms             ← was 7306ms
```

"⚠ Cancelled" should now render in ~5 ms instead of ~8 s.

---

## 10. Everything we ruled out (for the record)

| Suspect | Evidence against |
|---|---|
| Keypress → `abort()` | Trace: **0ms**. |
| Event loop blocked | Keypress handler ran, and the abort *event* was delivered to the request options in **2ms** — the loop was alive. |
| Jina embedding / memory phase | Trace: memory context built in **2ms** (and now explicitly timed). |
| bash/grep child-kill | `cancel.check.ts` §4 asserts child killed in < 3s (actually ~600ms); bash wasn't running at abort time anyway. |
| Groq SDK ignoring the signal | Standalone probes with the real key/SDK/Bun: **16–20ms** rejections; SDK source shows the signal reaches the fetch and the abort check is retry-proof. |
| SDK default timeout | 60s, but the app rejected at ~13–15s. |
| OTel `span.end()` blocking | Measured **2ms** with the OTLP endpoint unreachable; no auto-instrumentation registered. |
| Context summarization | Not triggered at this message volume (log shows `0 compressed`). |

---

## 11. Lessons learned

1. **Trace end-to-end before theorizing.** A single "it's slow" turned into a precise `keypress → abort → fetch` timeline in one pass. The gap-between-lines technique is what made the diagnosis obvious.
2. **Verify the layer you *can't* patch first.** We proved the SDK was innocent with throwaway probes against the real stack before blaming it — the bottleneck turned out to be Bun's fetch, which we can't fix and therefore must out-maneuver.
3. **Never trust a slow path to settle.** Abort was *eventually* honored by the fetch — "eventually" being 7+ seconds. Anything that must respond promptly to cancellation needs a watchdog/race at a layer that runs on the JS thread, not inside the runtime's I/O.
4. **A test that passes under both old and new behavior proves nothing.** The timing assertion (watchdog < 500ms vs. fake settle 1s) is what actually locks in the fix.
5. **Keep the trace.** The `[CancelLatency]` instrumentation is silent unless an abort happens, so it costs nothing in normal runs — and it will pinpoint the next latency hop instantly.

## 12. Files touched

| File | Change |
|---|---|
| `packages/cli/src/agent/cancel-latency.ts` | **new** — the trace module |
| `packages/cli/src/ui/index.tsx` | trace t0 in `cancelRun`, final-render line in `handleSubmit` |
| `packages/cli/src/agent/loop.ts` | `logCancelLatency` at every loop phase |
| `packages/cli/src/llm-client/groq-client.ts` | bisect lines + **abort watchdog** (the fix) |
| `packages/cli/src/agent/tools.ts` | bash/grep kill-path trace lines |
| `packages/cli/src/agent/memory/EpisodicMemoryManager.ts` | embedding duration always logged |
| `packages/cli/src/agent/cancel.check.ts` | watchdog timing assertion (test 5) + tracer test (test 6) |
