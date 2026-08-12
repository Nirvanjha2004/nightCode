// stream.check.ts — assert-based self-check for the normalized stream layer.
// Verifies: SSE line parsing (incl. [DONE] and CRLF), collectResponse
// assembling text/reasoning, tool calls from streamed argument deltas (split
// across many chunks), usage passthrough, error events, and tool-argument
// parse failures surfacing as ToolCallingError.
// Run with: bun packages/cli/src/llm-client/stream.check.ts
import assert from "node:assert/strict";
import { collectResponse, parseSSE } from "./stream";
import { ToolCallingError } from "./errors";
import type { LLMEvent, LLMResponse } from "./types";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[i]!));
            i++;
        },
    });
}

async function collect(payloads: string[]): Promise<LLMResponse> {
    // OpenAI-compatible chunk shapes → normalized events (mirrors the
    // transport's SSE mapping, in miniature, for the stream-layer check).
    const eventPayloads = payloads.filter((p) => p.startsWith("data:"));
    const stream = sseStream([eventPayloads.join("\n\n") + "\n\n"]);
    const evts: LLMEvent[] = [];
    for await (const p of parseSSE(stream)) {
        const chunk = JSON.parse(p) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            evts.push({ type: "reasoning_delta", text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content) {
            evts.push({ type: "text_delta", text: delta.content });
        }
        if (chunk.usage) {
            evts.push({
                type: "usage",
                usage: {
                    inputTokens: chunk.usage.prompt_tokens ?? 0,
                    outputTokens: chunk.usage.completion_tokens ?? 0,
                    totalTokens: chunk.usage.total_tokens ?? 0,
                    estimatedCost: "unknown",
                },
            });
        }
        if (choice?.finish_reason) {
            evts.push({ type: "finish", stopReason: choice.finish_reason });
        }
    }
    return collectResponse(events(evts));
}

/** Wrap an event array in an async iterable (collectResponse needs one). */
async function* events(evts: LLMEvent[]): AsyncGenerator<LLMEvent> {
    for (const e of evts) yield e;
}

async function main() {
    // ── SSE parser ────────────────────────────────────────────────────
    const raw = sseStream([
        'data: {"a":1}\n\n',
        'data: {"b":2}\n\ndata: [DONE]\n\n',
        "ignored: field\n\n",
        'data: {"c":3}\n\n',
    ]);
    const payloads: string[] = [];
    for await (const p of parseSSE(raw)) payloads.push(p);
    assert.deepEqual(payloads, ['{"a":1}', '{"b":2}'], "SSE data lines parsed, [DONE] stops the stream, non-data lines ignored");
    assert.equal(payloads.length, 2);

    // CRLF + multi-line chunk boundaries
    const crlf = sseStream(['data: {"x":1}\r\ndata: {"x":2}\r', '\n\r\n']);
    const crlfPayloads: string[] = [];
    for await (const p of parseSSE(crlf)) crlfPayloads.push(p);
    assert.deepEqual(crlfPayloads, ['{"x":1}', '{"x":2}'], "CRLF + chunk-split lines handled");

    // ── collectResponse: text + reasoning + usage ─────────────────────
    const textResp = await collectResponse(events([
        { type: "reasoning_delta", text: "think " },
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCost: "unknown" } },
        { type: "finish", stopReason: "stop" },
    ]));
    assert.equal(textResp.type, "text");
    if (textResp.type === "text") {
        assert.equal(textResp.content, "Hello world", "text deltas concatenated in order");
        assert.equal(textResp.reasoning, "think ", "reasoning deltas captured separately");
        assert.equal(textResp.usage?.totalTokens, 15, "usage attached");
    }

    // ── collectResponse: streamed tool call across many deltas ────────
    const toolResp = await collectResponse(events([
        { type: "tool_call_start", index: 0, id: "call_1", name: "read" },
        { type: "tool_call_delta", index: 0, argumentsDelta: '{"fi' },
        { type: "tool_call_delta", index: 0, argumentsDelta: 'le": "' },
        { type: "tool_call_delta", index: 0, argumentsDelta: "src/a.ts\"}" },
        { type: "tool_call_end", index: 0 },
        { type: "tool_call_start", index: 1, id: "call_2", name: "bash" },
        { type: "tool_call_delta", index: 1, argumentsDelta: '{"command": "ls"}' },
        { type: "tool_call_end", index: 1 },
        { type: "finish", stopReason: "tool_calls" },
    ]));
    assert.equal(toolResp.type, "tool_calls");
    if (toolResp.type === "tool_calls") {
        assert.equal(toolResp.toolCalls.length, 2, "both tool calls assembled");
        assert.deepEqual(toolResp.toolCalls[0]?.args, { file: "src/a.ts" }, "split argument JSON reassembled");
        assert.deepEqual(toolResp.toolCalls[1]?.args, { command: "ls" }, "single-chunk args parsed");
        assert.equal(toolResp.toolCalls[1]?.name, "bash");
    }

    // ── collectResponse: interleaved text + tool calls ────────────────
    const mixed = await collectResponse(events([
        { type: "text_delta", text: "Let me check" },
        { type: "tool_call_start", index: 0, id: "c", name: "grep" },
        { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
        { type: "tool_call_end", index: 0 },
    ]));
    assert.equal(mixed.type, "tool_calls", "tool calls win over trailing text");
    if (mixed.type === "tool_calls") assert.equal(mixed.toolCalls[0]?.name, "grep");

    // ── tool calls that never got an explicit end are still finished ──
    const noEnd = await collectResponse(events([
        { type: "tool_call_start", index: 0, id: "c9", name: "ls" },
        { type: "tool_call_delta", index: 0, argumentsDelta: '{"dir":"."}' },
    ]));
    assert.equal(noEnd.type, "tool_calls");
    if (noEnd.type === "tool_calls") assert.equal(noEnd.toolCalls.length, 1, "unterminated tool call still returned");

    // ── error events propagate ────────────────────────────────────────
    await assert.rejects(
        collectResponse(events([
            { type: "text_delta", text: "partial" },
            { type: "error", error: new ToolCallingError({ message: "boom" }) },
        ])),
        ToolCallingError,
        "error events throw the normalized error"
    );

    // ── malformed tool arguments → ToolCallingError ───────────────────
    await assert.rejects(
        collectResponse(events([
            { type: "tool_call_start", index: 0, id: "c", name: "read" },
            { type: "tool_call_delta", index: 0, argumentsDelta: "not json" },
            { type: "tool_call_end", index: 0 },
        ])),
        ToolCallingError,
        "unparseable tool arguments surface as ToolCallingError"
    );

    // ── integration: real OpenAI-compatible SSE payloads ──────────────
    const openai = await collect(
        [
            'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}',
            'data: {"choices":[{"delta":{"content":"The answer is "}}]}',
            'data: {"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}]}',
            'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
            "data: [DONE]",
        ].map((d) => d + "\n")
    );
    assert.equal(openai.type, "text");
    if (openai.type === "text") {
        assert.equal(openai.content, "The answer is 42", "OpenAI-style payloads normalize to text");
        assert.equal(openai.reasoning, "hmm", "reasoning_content normalizes to reasoning");
        assert.equal(openai.usage?.inputTokens, 7, "usage normalized");
    }

    console.log("PASS — SSE parsing and normalized event collection verified.");
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
