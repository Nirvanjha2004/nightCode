// transports.check.ts — assert-based self-check for the provider transports.
// Runs the real transports against LOCAL mock servers (no API keys), plus
// offline SigV4 test vectors and the AWS event-stream frame parser.
// Verifies: request/response normalization, capability adaptation
// (developer role, reasoning effort, thinking budget), tool-call streaming,
// error classification, SigV4 signing, and AWS event-stream framing.
// Run with: bun packages/cli/src/llm-client/transports.check.ts
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "./transports/openai-compatible";
import { AnthropicProvider } from "./transports/anthropic";
import { GoogleProvider } from "./transports/google";
import { signRequest } from "./transports/sigv4";
import { parseAwsEventFrame, parseAwsEventStream, framePayloadJson } from "./transports/aws-event-stream";
import { ModelNotFoundError, RateLimitError } from "./errors";
import type { ContextType } from "../agent/types";

function context(overrides: Partial<ContextType> = {}): ContextType {
    return {
        sessionId: "s",
        model: "m",
        systemPrompt: "You are NightCode.",
        messages: [],
        tools: [],
        ...overrides,
    };
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
    return JSON.parse(await req.text() || "{}") as Record<string, unknown>;
}

async function main() {
    // ── OpenAI-compatible: text streaming ─────────────────────────────
    {
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await jsonBody(req);
                assert.equal(body.stream, true, "streaming requested");
                assert.equal(body.model, "m");
                assert.equal((body.messages as Array<{ role: string }>)[0]?.role, "system", "system role by default");
                assert.ok(!("reasoning_effort" in body), "no reasoning_effort for non-reasoning models");
                return new Response(
                    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
                    'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n' +
                    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
                    "data: [DONE]\n\n",
                    { headers: { "content-type": "text/event-stream" } }
                );
            },
        });
        const p = new OpenAICompatibleProvider(
            { providerId: "mock", displayName: "Mock", api: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [] },
            "sk-test"
        );
        const resp = await p.chat(context());
        assert.equal(resp.type, "text");
        if (resp.type === "text") {
            assert.equal(resp.content, "Hi there", "text streamed and accumulated");
            assert.equal(resp.usage?.totalTokens, 5, "usage from the final chunk");
        }
        server.stop(true);
    }

    // ── OpenAI-compatible: streamed tool call + capability adaptation ──
    {
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await jsonBody(req);
                const msgs = body.messages as Array<{ role: string }>;
                assert.equal(msgs[0]?.role, "developer", "developer-role model gets a developer system message");
                assert.equal(body.reasoning_effort, "high", "reasoning effort translated when supported");
                assert.equal((body.tools as Array<{ type: string }>)[0]?.type, "function", "tools passed through");
                return new Response(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":""}}]}}]}\n\n' +
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file\\":"}}]}}]}\n\n' +
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
                    "data: [DONE]\n\n",
                    { headers: { "content-type": "text/event-stream" } }
                );
            },
        });
        const p = new OpenAICompatibleProvider(
            {
                providerId: "mock", displayName: "Mock", api: "openai-compatible",
                baseUrl: `http://127.0.0.1:${server.port}/v1`,
                models: [{ id: "m", name: "m", provider: "mock", contextWindow: 128000, maxOutputTokens: 8192, inputModalities: ["text"], outputModalities: ["text"], reasoning: true, reasoningEffort: true, toolCalling: true, vision: false, structuredOutput: false, parallelToolCalls: true, developerMessages: true }],
            },
            "sk-test"
        );
        const resp = await p.chat(
            context({
                reasoningEffort: "high",
                tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: { file: { type: "string" } } } } }],
            })
        );
        assert.equal(resp.type, "tool_calls");
        if (resp.type === "tool_calls") {
            assert.equal(resp.toolCalls.length, 1);
            assert.equal(resp.toolCalls[0]?.name, "read");
            assert.deepEqual(resp.toolCalls[0]?.args, { file: "a.ts" }, "split tool args reassembled");
        }
        server.stop(true);
    }

    // ── OpenAI-compatible: error classification ───────────────────────
    {
        const server = Bun.serve({
            port: 0,
            fetch() {
                return new Response(JSON.stringify({ error: { message: "The model `m` does not exist" } }), { status: 404, headers: { "content-type": "application/json" } });
            },
        });
        const p = new OpenAICompatibleProvider(
            { providerId: "mock", displayName: "Mock", api: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [] },
            "sk-test"
        );
        await assert.rejects(p.chat(context()), ModelNotFoundError, "404 model → ModelNotFoundError");
        server.stop(true);
    }

    // ── OpenAI-compatible: rate limit + Retry-After header ────────────
    {
        let calls = 0;
        const server = Bun.serve({
            port: 0,
            fetch() {
                calls++;
                if (calls === 1) {
                    return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
                }
                return new Response('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
            },
        });
        const p = new OpenAICompatibleProvider(
            { providerId: "mock", displayName: "Mock", api: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [] },
            "sk-test"
        );
        const resp = await p.chat(context());
        assert.equal(resp.type === "text" ? resp.content : "", "recovered", "rate-limited request retried via Retry-After");
        assert.equal(calls, 2, "one retry happened");
        server.stop(true);
    }

    // ── Anthropic: system field, tool blocks, thinking, streaming ─────
    {
        let captured: Record<string, unknown> | undefined;
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                captured = await jsonBody(req);
                assert.equal(req.headers.get("x-api-key"), "sk-ant-test", "anthropic key header");
                assert.ok((captured.max_tokens as number) > 0, "max_tokens required and sent");
                assert.equal((captured.system as string).includes("NightCode"), true, "system prompt in the system field");
                assert.deepEqual(
                    captured.thinking,
                    { type: "enabled", budget_tokens: 8192 },
                    "reasoning effort maps to extended-thinking budget"
                );
                const tools = captured.tools as Array<{ name: string; input_schema: unknown }>;
                assert.equal(tools[0]?.name, "read", "tools mapped to input_schema");
                return new Response(
                    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n' +
                    'data: {"type":"content_block_stop","index":0}\n\n' +
                    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
                    'data: {"type":"message_stop"}\n\n',
                    { headers: { "content-type": "text/event-stream" } }
                );
            },
        });
        const p = new AnthropicProvider(
            { providerId: "anthropic", displayName: "Anthropic", api: "anthropic", baseUrl: `http://127.0.0.1:${server.port}`, models: [{ id: "m", name: "m", provider: "anthropic", contextWindow: 200000, maxOutputTokens: 8192, inputModalities: ["text"], outputModalities: ["text"], reasoning: true, reasoningEffort: false, toolCalling: true, vision: false, structuredOutput: false, parallelToolCalls: true, developerMessages: false }] },
            "sk-ant-test"
        );
        const resp = await p.chat(
            context({
                reasoningEffort: "high",
                tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } } }],
            })
        );
        assert.equal(resp.type, "text");
        if (resp.type === "text") {
            assert.equal(resp.content, "Hello world", "anthropic text blocks normalize");
            assert.equal(resp.usage?.inputTokens, 5, "anthropic usage normalized");
        }
        server.stop(true);
    }

    // ── Anthropic: tool_use / tool_result round trip ──────────────────
    {
        let captured: Record<string, unknown> | undefined;
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                captured = await jsonBody(req);
                const msgs = captured.messages as Array<{ role: string; content: unknown }>;
                const toolResult = msgs.find((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>)[0]?.type === "tool_result");
                assert.ok(toolResult, "tool result present");
                const block = (toolResult!.content as Array<{ type: string; tool_use_id: string; content: string }>)[0]!;
                assert.equal(block.tool_use_id, "call_1", "tool_use_id preserved");
                assert.equal(block.content, "file contents", "tool result content preserved");
                return new Response(
                    'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n' +
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"read","input":{}}}\n\n' +
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file\\":"}}\n\n' +
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}\n\n' +
                    'data: {"type":"content_block_stop","index":0}\n\n' +
                    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n' +
                    'data: {"type":"message_stop"}\n\n',
                    { headers: { "content-type": "text/event-stream" } }
                );
            },
        });
        const p = new AnthropicProvider(
            { providerId: "anthropic", displayName: "Anthropic", api: "anthropic", baseUrl: `http://127.0.0.1:${server.port}`, models: [] },
            "sk-ant-test"
        );
        const resp = await p.chat(
            context({
                messages: [
                    { messageId: "1", sessionId: "s", role: "assistant", content: "", createdAt: new Date(), toolCalls: [{ id: "call_1", name: "read", args: { file: "a.ts" } }] },
                    { messageId: "2", sessionId: "s", role: "tool", content: "file contents", createdAt: new Date(), toolCallId: "call_1" },
                ],
            })
        );
        assert.equal(resp.type, "tool_calls");
        if (resp.type === "tool_calls") {
            assert.equal(resp.toolCalls[0]?.id, "call_1");
            assert.deepEqual(resp.toolCalls[0]?.args, { file: "a.ts" }, "anthropic input_json_delta reassembled");
        }
        server.stop(true);
    }

    // ── Google: systemInstruction, functionCall/functionResponse ──────
    {
        let captured: Record<string, unknown> | undefined;
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                captured = await jsonBody(req);
                const sys = (captured.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text;
                assert.ok(sys.includes("NightCode"), "systemInstruction set");
                const gc = captured.generationConfig as { thinkingConfig?: { thinkingBudget?: number }; maxOutputTokens?: number };
                assert.ok((gc.maxOutputTokens as number) > 0, "maxOutputTokens set");
                const contents = captured.contents as Array<{ role: string; parts: Array<{ functionResponse?: { name: string } }> }>;
                const fnResp = contents.find((c) => c.parts.some((p) => p.functionResponse));
                assert.ok(fnResp, "functionResponse part present");
                return new Response(
                    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"file":"a.ts"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"thoughtsTokenCount":1}}\n\n',
                    { headers: { "content-type": "text/event-stream" } }
                );
            },
        });
        const p = new GoogleProvider(
            { providerId: "google", displayName: "Google", api: "google", baseUrl: `http://127.0.0.1:${server.port}`, models: [] },
            "google-test"
        );
        const resp = await p.chat(
            context({
                messages: [
                    { messageId: "1", sessionId: "s", role: "assistant", content: "", createdAt: new Date(), toolCalls: [{ id: "call_1", name: "read", args: { file: "a.ts" } }] },
                    { messageId: "2", sessionId: "s", role: "tool", content: "file contents", createdAt: new Date(), toolCallId: "call_1" },
                ],
            })
        );
        assert.equal(resp.type, "tool_calls");
        if (resp.type === "tool_calls") {
            assert.equal(resp.toolCalls[0]?.name, "read");
            assert.deepEqual(resp.toolCalls[0]?.args, { file: "a.ts" }, "gemini functionCall normalized");
            assert.equal(resp.usage?.reasoningTokens, 1, "gemini thoughtsTokenCount normalized");
        }
        server.stop(true);
    }

    // ── SigV4: AWS documentation test vector ──────────────────────────
    {
        const signed = signRequest({
            method: "GET",
            url: "https://example.amazonaws.com/",
            body: "",
            service: "service",
            region: "us-east-1",
            credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
            now: new Date("2015-08-30T12:36:00Z"),
        });
        assert.equal(
            signed.Authorization,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
            "SigV4 matches the AWS published get-vanilla test vector"
        );
        assert.equal(signed["x-amz-date"], "20150830T123600Z");
    }

    // ── SigV4: session token is signed when present ───────────────────
    {
        const signed = signRequest({
            method: "POST",
            url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse-stream",
            body: "{}",
            service: "bedrock",
            region: "us-east-1",
            credentials: {
                accessKeyId: "AKID",
                secretAccessKey: "SECRET",
                sessionToken: "TOKEN123",
            },
            now: new Date("2024-01-01T00:00:00Z"),
        });
        assert.equal(signed["x-amz-security-token"], "TOKEN123");
        assert.ok((signed.Authorization ?? "").includes("x-amz-security-token"), "session token is in SignedHeaders");
        assert.ok((signed.Authorization ?? "").includes("/bedrock/aws4_request"), "bedrock service scope");
    }

    // ── AWS event-stream: synthetic frame parse ───────────────────────
    {
        const payload = Buffer.from(JSON.stringify({ contentBlockDelta: { delta: { text: "hi" } } }));
        const name = Buffer.from(":event-type");
        const value = Buffer.from("chunk");
        const header1 = Buffer.concat([
            Buffer.from([name.length]), name, Buffer.from([7]),
            Buffer.from([0, value.length]), value,
        ]);
        const headers = Buffer.concat([Buffer.from([0, 1]), header1]);
        const prelude = Buffer.alloc(12);
        // total = prelude(12) + headers + payload + message CRC(4)
        prelude.writeUInt32BE(16 + headers.length + payload.length, 0);
        prelude.writeUInt32BE(headers.length, 4); // headers length
        // bytes 8..11 are the prelude CRC (unvalidated by the parser)
        const frame = Buffer.concat([prelude, headers, payload, Buffer.alloc(4)]);

        const parsed = parseAwsEventFrame(new Uint8Array(frame));
        assert.ok(parsed, "frame parsed");
        assert.equal(parsed!.frame.eventType, "chunk", "event-type header read");
        assert.deepEqual(
            framePayloadJson(parsed!.frame),
            { contentBlockDelta: { delta: { text: "hi" } } },
            "payload JSON decoded"
        );
        assert.equal(parsed!.next, frame.length, "frame length tracked");

        // incremental stream across arbitrary chunk boundaries
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of frame) controller.enqueue(new Uint8Array([byte!]));
                controller.close();
            },
        });
        const events: string[] = [];
        for await (const f of parseAwsEventStream(stream)) events.push(f.eventType);
        assert.deepEqual(events, ["chunk"], "byte-by-byte stream reassembled into one frame");

        // malformed frame (totalLength below the 16-byte minimum) → clear error
        const bad = Buffer.from(frame);
        bad.writeUInt32BE(8, 0);
        assert.throws(() => parseAwsEventFrame(new Uint8Array(bad)), /Malformed/, "impossible totalLength rejected");
    }

    console.log("PASS — transports normalize requests/responses; SigV4 + AWS event-stream verified offline.");
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
