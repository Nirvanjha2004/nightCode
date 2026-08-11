// groq-client.check.ts — assert-based self-check for the Groq client.
// (1) Error-code extraction: the SDK nests the API body as `err.error = { error:
// { code, ... } }`, so `err.error.code` was undefined and the `tool_use_failed`
// repair retry never fired — the raw 400 crashed the whole turn.
// (2) Streaming: the client uses stream:true and must consume chunks into the
// SAME LLMResponse shapes as before (full text / tool_calls), emit non-empty
// text deltas progressively, skip empty chunks, and reject with an AbortError
// the instant the run's signal fires mid-stream (cancellation is NOT an error).
// Run with: bun packages/cli/src/llm-client/groq-client.check.ts
import assert from "node:assert/strict";
import { getGroqErrorCode, GroqClient } from "./groq-client";
import type { ContextType } from "../agent/types";

// Minimal async-iterable stand-in for the SDK's Stream class.
function fakeStream(chunks: Array<Record<string, unknown>>): AsyncIterable<any> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c;
        },
    };
}

// A stream that yields once then never finishes — for abort tests.
function hangingStream(): AsyncIterable<any> {
    return {
        async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "partial" }, finish_reason: null }] };
            await new Promise(() => {}); // next() never resolves without the watchdog
        },
    };
}

function sseChunk(delta: Record<string, unknown>): Record<string, unknown> {
    return {
        id: "x",
        created: 0,
        model: "m",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
    };
}

const streamContext: ContextType = {
    sessionId: "s",
    model: "m",
    systemPrompt: "",
    messages: [],
    tools: [],
};

// 1. Real SDK shape (BadRequestError): err.error is the WHOLE body, so the
//    code lives one level deeper at err.error.error.code.
const sdkShape = {
    error: {
        error: {
            message: "Failed to call a function...",
            type: "invalid_request_error",
            code: "tool_use_failed",
            failed_generation: "<tool_call>\n<function=spawn_subagent>",
        },
    },
};
assert.equal(
    getGroqErrorCode(sdkShape),
    "tool_use_failed",
    "nested SDK error body (err.error.error.code) must be detected"
);

// 2. Flat fallbacks for other SDK shapes/versions.
assert.equal(
    getGroqErrorCode({ error: { code: "rate_limit_exceeded" } }),
    "rate_limit_exceeded",
    "flat err.error.code fallback"
);
assert.equal(
    getGroqErrorCode({ code: "internal_error" }),
    "internal_error",
    "bare err.code fallback"
);

// 3. Unrecognized errors → undefined (caller logs + rethrows).
assert.equal(getGroqErrorCode({}), undefined, "no code → undefined");
assert.equal(getGroqErrorCode(null), undefined, "null → undefined");
assert.equal(getGroqErrorCode(undefined), undefined, "undefined → undefined");
assert.equal(getGroqErrorCode("boom"), undefined, "non-object → undefined");

// 4. failed_generation is reachable at err.error.error.failed_generation —
//    this is the field the repair retry replays back to the model.
const e = sdkShape.error as { error?: { failed_generation?: string } };
assert.ok(
    e.error?.failed_generation?.includes("<function=spawn_subagent>"),
    "failed_generation readable at err.error.error.failed_generation"
);

// ── Streaming ───────────────────────────────────────────────────────────────
// 5. Text chunks accumulate into the FULL response and each non-empty content
//    delta is streamed out; empty chunks are skipped.
const gcText = new GroqClient("sk-fake");
const textInner = (gcText as any).client.chat.completions;
const deltas: string[] = [];
textInner.create = async () =>
    fakeStream([
        sseChunk({ role: "assistant", content: "Hel" }),
        sseChunk({ content: "lo " }),
        sseChunk({ content: null }), // empty chunk — must be skipped
        sseChunk({}),
        sseChunk({ content: "world" }),
    ]);
const textRes = await gcText.chat(streamContext, undefined, (t) => deltas.push(t));
assert.equal(textRes.type, "text", "text response type preserved");
if (textRes.type === "text") {
    assert.equal(textRes.content, "Hello world", "full streamed text accumulated (history gets the whole response)");
}
assert.deepEqual(deltas, ["Hel", "lo ", "world"], "only non-empty content deltas are emitted");

// 6. Tool-call fragments (split across chunks, index-keyed) reassemble into the
//    same ToolCall[] shape the non-streaming path returned.
const gcTool = new GroqClient("sk-fake");
const toolInner = (gcTool as any).client.chat.completions;
toolInner.create = async () =>
    fakeStream([
        sseChunk({ role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "" } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: "{\"fi" } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: "le\":\"a.ts\"}" } }] }),
    ]);
const toolRes = await gcTool.chat(streamContext);
assert.equal(toolRes.type, "tool_calls", "tool-call response type preserved");
if (toolRes.type === "tool_calls") {
    assert.deepEqual(toolRes.toolCalls, [{ id: "t1", name: "read", args: { file: "a.ts" } }], "split fragments reassembled");
}

// 7. A stream that yields only empty chunks (no text, no tool calls — e.g. a
//    run cut off by `length`) is an error, not a silent empty response.
const gcEmpty = new GroqClient("sk-fake");
const emptyInner = (gcEmpty as any).client.chat.completions;
emptyInner.create = async () =>
    fakeStream([
        sseChunk({ content: null }),
        sseChunk({}),
    ]);
await assert.rejects(
    gcEmpty.chat(streamContext),
    /Groq returned no content/,
    "empty stream rejects with the new contract error"
);

// 8. Abort mid-stream rejects with AbortError immediately (the watchdog races
//    the hanging next() read) — cancellation must not surface as a normal error.
const gcAbort = new GroqClient("sk-fake");
const abortInner = (gcAbort as any).client.chat.completions;
abortInner.create = async () => hangingStream();
const abortCtl = new AbortController();
const abortPromise = gcAbort.chat(streamContext, abortCtl.signal);
await new Promise((r) => setTimeout(r, 20));
abortCtl.abort();
await assert.rejects(
    abortPromise,
    (err: any) => err?.name === "AbortError",
    "mid-stream abort rejects with AbortError"
);

console.log("PASS — Groq error-code extraction + streaming (deltas, tool-call reassembly, empty chunks, empty-response, abort).");
