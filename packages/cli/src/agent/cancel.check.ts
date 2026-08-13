// cancel.check.ts — assert-based self-check for agent cancellation/interrupt.
// Verifies: (1) an aborted run stops BETWEEN steps — no further LLM calls or
// new tools — while in-flight tool results are still stored so message history
// keeps its assistant-tool_calls → tool pairing; (2) aborting mid-batch pairs
// the remaining calls with synthetic cancelled results (no orphaned tool_calls);
// (3) a pre-aborted signal never starts the run; (4) the bash tool kills its
// child process on abort and surfaces cancellation (AbortError), not a "killed"
// shell result; (5) the Groq client forwards the AbortSignal into the request
// and does not retry it.
// Run with: bun packages/cli/src/agent/cancel.check.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";
import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";
import { ContextBuilder } from "./context";
import { CommandRegistry } from "./commands";
import { AgentHarness } from "./agent-harness";
import { AgentLoop } from "./loop";
import { EpisodicMemoryManager } from "./memory/EpisodicMemoryManager";
import { SemanticMemoryManager } from "./memory/SemanticMemoryManager";
import { ProceduralMemoryManager } from "./memory/ProceduralMemoryManager";
import { bash } from "./tools";
import { OpenAICompatibleProvider } from "../llm-client/transports/openai-compatible";
import type { ContextType, Tool } from "./types";
import type { ChatLLM, LLMEvent, LLMResponse } from "../llm-client/types";
import { eventsFromResponse } from "../llm-client/stream";

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "cancel-check-"));

    // The ContextBuilder's LLM is only used for context summarization,
    // which never triggers at this message volume — a stub suffices.
    const fakeLLM = {
        chat: async (): Promise<LLMResponse> => ({ type: "text", content: "stub" }),
        // ContextBuilder only ever calls chat() (summarization) — stream is
        // required by the interface but never exercised here.
        stream: async function* (): AsyncGenerator<LLMEvent> {
            yield { type: "text_delta", text: "stub" };
            yield { type: "finish" };
        },
        summarizerModel: () => "stub-model",
        contextLimit: () => 131_072,
        subagentModel: () => "stub-model",
    };

    function buildHarness(extraTools: Tool[] = []) {
        const messageManager = new MessageManager();
        const sessionManager = new SessionManager();
        const toolRegistry = new ToolRegistry();
        for (const tool of extraTools) toolRegistry.register(tool);

        const semanticMemory = new SemanticMemoryManager(join(dir, "semantic.json"));
        const proceduralMemory = new ProceduralMemoryManager(join(dir, "procedural.md"));
        const episodicMemory = new EpisodicMemoryManager(join(dir, "events.jsonl"));
        // Stub out the network call — episodic retrieval is not what this check tests.
        episodicMemory.retrieveRelevantMemories = async () => [];

        const contextBuilder = new ContextBuilder(messageManager, sessionManager, toolRegistry, fakeLLM);
        const commandRegistry = new CommandRegistry();
        const harness = new AgentHarness(
            messageManager,
            sessionManager,
            toolRegistry,
            contextBuilder,
            episodicMemory,
            semanticMemory,
            proceduralMemory,
            commandRegistry
        );
        harness.onTaskComplete = async () => {}; // no real memory extraction in a check
        return { harness, messageManager, sessionManager };
    }

    try {
        // ── 1. Abort mid-tool: run stops between steps, history stays valid ──
        // overrideMemoryContext skips the memory build; the tool resolves a
        // "started" promise and the abort fires from THAT, so the timing is
        // deterministic on any machine (no wall-clock races).
        let toolExecutions = 0;
        let toolStarted!: () => void;
        const toolStartedPromise = new Promise<void>((r) => { toolStarted = r; });
        const slowTool: Tool = {
            name: "slow_tool",
            description: "slow",
            parameters: { type: "object", properties: {} },
            exec: async () => {
                toolExecutions++;
                toolStarted();
                await new Promise((r) => setTimeout(r, 100));
                return "done";
            },
        };
        const { harness, messageManager, sessionManager } = buildHarness([slowTool]);

        let llmCalls = 0;
        const llm: ChatLLM = {
            chat: async (_c: ContextType): Promise<LLMResponse> => {
                llmCalls++;
                return {
                    type: "tool_calls",
                    toolCalls: [{ id: "c1", name: "slow_tool", args: {} }],
                };
            },
            stream: async function* (_context: ContextType, _signal?: AbortSignal) {
                yield* eventsFromResponse(await this.chat(_context));
            },
            summarizerModel: () => "stub-model",
            contextLimit: () => 131_072,
            subagentModel: () => "stub-model",
        };
        const loop = new AgentLoop(harness, llm, 5);
        harness.agentLoop = loop;
        const sessionId = sessionManager.create({ model: "qwen/qwen3.6-27b" });

        const controller = new AbortController();
        const executePromise = loop.execute(sessionId, "do the thing", {
            signal: controller.signal,
            overrideMemoryContext: "",
        });
        await toolStartedPromise; // tool is now mid-flight
        controller.abort();
        await assert.rejects(executePromise, isAbort, "aborted run must reject with an AbortError");

        assert.equal(llmCalls, 1, "no further LLM call after abort — loop stops between steps");
        assert.equal(toolExecutions, 1, "no NEW tool runs after abort");

        // History integrity: the in-flight tool's result was still stored, so the
        // assistant tool_calls message is paired with a tool response and the NEXT
        // prompt won't be rejected for orphaned tool calls.
        const history = messageManager.get(sessionId);
        const toolResults = history.filter((m) => m.role === "tool");
        assert.equal(toolResults.length, 1, "in-flight tool result stored (history pairing preserved)");
        assert.equal(toolResults[0]?.toolCallId, "c1", "tool result links to the assistant intent");
        assert.equal(toolResults[0]?.content, "done", "completed tool stored its real result");

        // ── 2. Abort mid-batch: remaining calls get synthetic cancelled results ──
        let toolExecs2 = 0;
        let toolStarted2!: () => void;
        const toolStartedPromise2 = new Promise<void>((r) => { toolStarted2 = r; });
        const slowTool2: Tool = {
            name: "slow_tool",
            description: "slow",
            parameters: { type: "object", properties: {} },
            exec: async () => {
                toolExecs2++;
                toolStarted2();
                await new Promise((r) => setTimeout(r, 100));
                return "done";
            },
        };
        const { harness: h2, messageManager: mm2, sessionManager: sm2 } = buildHarness([slowTool2]);
        const llm2: ChatLLM = {
            chat: async (_c: ContextType): Promise<LLMResponse> => {
                return {
                    type: "tool_calls",
                    toolCalls: [
                        { id: "b1", name: "slow_tool", args: {} },
                        { id: "b2", name: "slow_tool", args: {} },
                    ],
                };
            },
            stream: async function* (_context: ContextType, _signal?: AbortSignal) {
                yield* eventsFromResponse(await this.chat(_context));
            },
            summarizerModel: () => "stub-model",
            contextLimit: () => 131_072,
            subagentModel: () => "stub-model",
        };
        const loop2 = new AgentLoop(h2, llm2, 5);
        h2.agentLoop = loop2;
        const sessionId2 = sm2.create({ model: "qwen/qwen3.6-27b" });

        const c2 = new AbortController();
        const executePromise2 = loop2.execute(sessionId2, "batch", {
            signal: c2.signal,
            overrideMemoryContext: "",
        });
        await toolStartedPromise2; // b1 is now mid-flight
        c2.abort();
        await assert.rejects(executePromise2, isAbort, "mid-batch abort must reject with an AbortError");
        assert.equal(toolExecs2, 1, "the second tool call never ran after abort");
        const batchTools = mm2.get(sessionId2).filter((m) => m.role === "tool");
        assert.equal(batchTools.length, 2, "every tool_call id got a tool response (no orphaned intents)");
        assert.deepEqual(
            batchTools.map((m) => m.toolCallId).sort(),
            ["b1", "b2"],
            "all tool_call ids paired, in order"
        );
        const cancelledResult = batchTools.find((m) => m.toolCallId === "b2")?.content ?? "";
        assert.ok(cancelledResult.includes("cancelled"), "unrun call got a synthetic cancelled result");

        // ── 3. Pre-aborted signal: run never starts ──
        const pre = new AbortController();
        pre.abort();
        const sessionId3 = sessionManager.create({ model: "qwen/qwen3.6-27b" });
        await assert.rejects(
            loop.execute(sessionId3, "never runs", { signal: pre.signal }),
            isAbort,
            "pre-aborted signal must reject without starting"
        );
        assert.equal(llmCalls, 1, "pre-aborted signal → LLM never called");
        assert.equal(messageManager.get(sessionId3).length, 0, "pre-aborted run stores no messages");

        // ── 4. bash tool kills its child process on abort ──
        // A command that would run for 10s must be cancelled in milliseconds —
        // if the child were orphaned, the promise would only settle via the
        // 4s exec timeout and the elapsed assertion below would fail.
        const sleepCmd = os.platform() === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
        const bashController = new AbortController();
        const started = Date.now();
        const bashPromise = bash.exec(
            { command: sleepCmd, timeout: 4000 },
            undefined,
            bashController.signal
        );
        setTimeout(() => bashController.abort(), 150);
        await assert.rejects(bashPromise, isAbort, "cancelled bash must surface AbortError, not a killed result");
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 3000, `bash child killed promptly on abort (took ${elapsed}ms)`);

        // ── 5. The provider transport forwards the AbortSignal; abort is not retried ──
        // A local mock server holds the request open; aborting mid-flight must
        // settle the chat() via the abort watchdog (~ms) and never retry.
        let requests = 0;
        const server = Bun.serve({
            port: 0,
            async fetch(_req) {
                requests++;
                await Bun.sleep(200);
                return new Response(
                    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    { headers: { "content-type": "text/event-stream" } }
                );
            },
        });
        const transport = new OpenAICompatibleProvider(
            {
                providerId: "mock",
                displayName: "Mock",
                api: "openai-compatible",
                baseUrl: `http://localhost:${server.port}/v1`,
                models: [],
            },
            "sk-fake"
        );
        const abort5 = new AbortController();
        const context5: ContextType = {
            sessionId: "s",
            model: "m",
            systemPrompt: "",
            messages: [],
            tools: [],
        };
        const started5 = Date.now();
        const transportPromise = transport.chat(context5, abort5.signal);
        setTimeout(() => abort5.abort(), 20);
        // Cancellation rejects with CancelledError (name "AbortError", message
        // "Agent run cancelled.") via the abort watchdog — match by name, the
        // same convention as the other abort assertions in this file.
        await assert.rejects(transportPromise, isAbort, "aborted LLM request rejects");
        assert.ok(Date.now() - started5 < 3000, "abort settles quickly via the watchdog");
        await Bun.sleep(300); // let the orphaned request settle in the background
        assert.equal(requests, 1, "aborted request is not retried or repaired");
        server.stop(true);

        console.log(
            "PASS — loop stops between steps on abort, history stays paired, bash kills its child, the transport forwards the AbortSignal."
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
