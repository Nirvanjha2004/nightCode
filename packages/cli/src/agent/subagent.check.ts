// subagent.check.ts — assert-based self-check for the subagent feature.
// Verifies the contract: spawn_subagent runs a NESTED AgentLoop.execute on a
// fresh, isolated session; the subagent sees only its scoped tools; memory
// extraction fires for the parent only (no duplicate writes).
// Run with: bun packages/cli/src/agent/subagent.check.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { read, grep, spawnSubagent } from "./tools";
import type { ContextType } from "./types";
import type { ChatLLM, LLMEvent, LLMResponse } from "../llm-client/types";
import { eventsFromResponse } from "../llm-client/stream";

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "subagent-check-"));

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

    try {
        const messageManager = new MessageManager();
        const sessionManager = new SessionManager();
        const toolRegistry = new ToolRegistry();
        for (const tool of [read, grep, spawnSubagent]) toolRegistry.register(tool);

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

        // Replace the real (LLM-based) extraction with a counter.
        let extractionCount = 0;
        const extractionTraces: string[] = [];
        harness.onTaskComplete = async (trace: string) => {
            extractionCount++;
            extractionTraces.push(trace);
        };

        // Stub LLM: the FIRST parent call spawns a subagent; every later call
        // (subagent's turns + the parent's follow-up) returns a text answer.
        // Record which tools each call actually saw, keyed by session.
        const seen: Array<{ sessionId: string; tools: string[] }> = [];
        let callCount = 0;
        const llm: ChatLLM = {
            chat: async (context: ContextType): Promise<LLMResponse> => {
                seen.push({
                    sessionId: context.sessionId,
                    tools: context.tools.map((t) => t.function?.name ?? ""),
                });
                callCount++;
                if (callCount === 1) {
                    return {
                        type: "tool_calls",
                        toolCalls: [
                            {
                                id: "call_1",
                                name: "spawn_subagent",
                                args: {
                                    task: "Find all files that import './auth' and report the list.",
                                    allowedTools: ["read", "grep"],
                                },
                            },
                        ],
                    };
                }
                return { type: "text", content: callCount === 2 ? "subagent report" : "parent summary" };
            },
            stream: async function* (_context: ContextType, _signal?: AbortSignal) {
                yield* eventsFromResponse(await this.chat(_context));
            },
            summarizerModel: () => "stub-model",
            contextLimit: () => 131_072,
            subagentModel: () => "stub-model",
        };

        const agentLoop = new AgentLoop(harness, llm, 5);
        harness.agentLoop = agentLoop;

        const parentSessionId = sessionManager.create({ model: "qwen/qwen3.6-27b" });
        const result = await agentLoop.execute(parentSessionId, "Find all files that import './auth'");

        // ── Assertions ─────────────────────────────────────────────────
        assert.equal(result, "parent summary", "parent returns its own final text answer");

        // 1. A fresh, isolated subagent session was created with its own model.
        const subSessions = sessionManager
            .list()
            .filter((s) => s.sessionId !== parentSessionId);
        assert.equal(subSessions.length, 1, "exactly one subagent session created");
        const subSession = subSessions[0];
        assert.ok(subSession, "subagent session present");
        assert.equal(subSession.model, "llama-3.1-8b-instant", "subagent uses the cheap focused model");

        // 2. The subagent's context exposed EXACTLY the scoped tools — not the full registry.
        const subCalls = seen.filter((c) => c.sessionId === subSession.sessionId);
        assert.ok(subCalls.length >= 1, "subagent made at least one LLM call");
        for (const c of subCalls) {
            assert.deepEqual([...c.tools].sort(), ["grep", "read"], "subagent only sees its scoped tools");
        }
        // The parent still saw the full (unrestricted) tool list.
        const parentToolList = seen.filter((c) => c.sessionId === parentSessionId)[0]?.tools ?? [];
        assert.ok(
            parentToolList.includes("spawn_subagent"),
            "parent sees the spawn_subagent tool"
        );

        // 3. Regression guard: the spawn_subagent TOOL RESULT must be stored back
        //    in message history as a role:"tool" message linked by toolCallId.
        //    (Regression: ce8ba03 accidentally replaced this storage with a
        //    duplicate assistant intent message, so tool outputs never reached
        //    the model — every tool looked like it returned empty results.)
        const parentHistory = messageManager.get(parentSessionId);
        const toolResults = parentHistory.filter((m) => m.role === "tool");
        assert.equal(toolResults.length, 1, "spawn_subagent result stored as a tool message");
        const spawnResult = toolResults[0];
        assert.ok(spawnResult, "tool result message present");
        assert.equal(spawnResult.toolCallId, "call_1", "tool result links to the assistant intent by toolCallId");
        assert.equal(spawnResult.content, "subagent report", "tool result carries the subagent's final summary");

        // 4. Memory extraction fired exactly once — for the parent only.
        // saveMemoryAsync is fire-and-forget; give the promise a beat to resolve.
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(extractionCount, 1, "memory extraction ran for the parent only, not the subagent");
        assert.ok(
            extractionTraces[0]?.includes("Find all files that import './auth'") ?? false,
            "parent trace stored"
        );

        // 5. Trust-boundary guards: the schema's `required` is advisory, so the
        //    tool must reject a malformed call itself (no silent full-tool fallback).
        await assert.rejects(
            spawnSubagent.exec({ task: "something" }, harness),
            /non-empty `allowedTools`/,
            "missing allowedTools is rejected, never silently granting full access"
        );
        await assert.rejects(
            spawnSubagent.exec({ task: "", allowedTools: ["read"] }, harness),
            /non-empty `task`/,
            "empty task is rejected"
        );

        console.log(
            "PASS — subagent session isolated, tools scoped, no duplicate memory extraction."
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
