// activity.check.ts — assert-based self-check for the UI activity event stream.
// Verifies: previews stay small (bash shows the command, args/results are capped),
// and AgentLoop emits a well-ordered stage → iteration → tool_start/tool_end stream
// that the terminal feed renders (success and failure both reported, tool_end never
// before its tool_start — otherwise the UI would keep a ghost live row forever).
// Run with: bun packages/cli/src/agent/activity.check.ts
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
import { AgentLoop, previewToolArgs, previewToolResult, summarizeToolFailure } from "./loop";
import { EpisodicMemoryManager } from "./memory/EpisodicMemoryManager";
import { SemanticMemoryManager } from "./memory/SemanticMemoryManager";
import { ProceduralMemoryManager } from "./memory/ProceduralMemoryManager";
import type { AgentEvent, ContextType, Tool } from "./types";
import type { ChatLLM, LLMEvent, LLMResponse } from "../llm-client/types";
import { eventsFromResponse } from "../llm-client/stream";

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "activity-check-"));

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
        // ── preview helpers ────────────────────────────────────────────
        assert.equal(
            previewToolArgs("bash", { command: "npm test" }),
            "npm test",
            "bash preview shows the command itself, not its JSON wrapper"
        );
        assert.ok(
            previewToolArgs("write", { file: "a.ts", content: "x".repeat(500) }).endsWith("…"),
            "long args are truncated"
        );
        assert.ok(
            previewToolArgs("bash", { command: "echo " + "a".repeat(500) }).endsWith("…"),
            "long bash commands are truncated too"
        );
        assert.equal(
            previewToolArgs("read", { file: "a.ts" }),
            '{"file":"a.ts"}',
            "short non-bash args stay JSON"
        );

        const multi = previewToolResult(
            ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
        );
        assert.ok(multi.includes("(2 more lines)"), "result preview caps lines with a marker");
        assert.ok(!multi.includes("line7"), "capped lines are dropped");
        assert.equal(previewToolResult("done"), "done", "short result unchanged");

        const huge = previewToolResult("line1\n" + "x".repeat(10_000));
        assert.ok(huge.includes("output truncated"), "huge results get a truncation marker");
        assert.ok(huge.length < 500, "huge preview stays bounded (marker not cut off)");

        // ── failure summaries stay concise ────────────────────────────
        assert.equal(
            summarizeToolFailure("Error: File not found: src/nonexistent.ts"),
            "File not found: src/nonexistent.ts",
            "thrown errors strip the Error: prefix"
        );
        const shellFailText =
            "$ npm test\n--- stdout ---\n1 passed\n--- stderr ---\n2 tests failed\nExpected 200 but received 401\nexit code: 1 — took 3200ms";
        assert.equal(
            summarizeToolFailure(shellFailText),
            "exit code 1\n2 tests failed",
            "shell failures surface exit code + first stderr line"
        );
        assert.ok(
            summarizeToolFailure("Error: " + "y".repeat(500)).length <= 120,
            "failure summary is bounded"
        );

        // ── event stream ───────────────────────────────────────────────
        const fakeTool: Tool = {
            name: "fake_tool",
            description: "noop",
            parameters: { type: "object", properties: {}, required: [] },
            exec: async () => "done",
        };
        const badTool: Tool = {
            name: "bad_tool",
            description: "always throws",
            parameters: { type: "object", properties: {}, required: [] },
            exec: async () => {
                throw new Error("boom");
            },
        };
        const shellFailTool: Tool = {
            name: "shell_fail",
            description: "returns a shell-style failure result",
            parameters: { type: "object", properties: {}, required: [] },
            exec: async () => ({
                ok: false,
                text: "$ npm test\n--- stdout ---\n1 passed\n--- stderr ---\n2 tests failed\nExpected 200 but received 401\nexit code: 1 — took 3200ms",
            }),
        };
        const changeToolSummary =
            "Updated src/auth.ts\n+1 -1 lines\n\n- const token = req.headers.authorization;\n+ const token = req.headers.authorization?.replace(\"Bearer \", \"\");";
        const changeTool: Tool = {
            name: "change_tool",
            description: "returns a structured result with a display-only change summary",
            parameters: { type: "object", properties: {}, required: [] },
            exec: async () => ({
                text: "Wrote src/auth.ts",
                changeSummary: changeToolSummary,
            }),
        };

        const messageManager = new MessageManager();
        const sessionManager = new SessionManager();
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(fakeTool);
        toolRegistry.register(badTool);
        toolRegistry.register(shellFailTool);
        toolRegistry.register(changeTool);

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

        const events: AgentEvent[] = [];
        let calls = 0;
        const llm: ChatLLM = {
            chat: async (_context: ContextType): Promise<LLMResponse> => {
                calls++;
                if (calls === 1) {
                    return {
                        type: "tool_calls",
                        toolCalls: [
                            { id: "c1", name: "fake_tool", args: {} },
                            { id: "c2", name: "bad_tool", args: {} },
                            { id: "c3", name: "shell_fail", args: {} },
                            { id: "c4", name: "change_tool", args: {} },
                        ],
                    };
                }
                return { type: "text", content: "all good" };
            },
            // The loop consumes stream(), not chat() — delegate and convert.
            stream: async function* (_context: ContextType, _signal?: AbortSignal) {
                yield* eventsFromResponse(await this.chat(_context));
            },
            summarizerModel: () => "stub-model",
            contextLimit: () => 131_072,
            subagentModel: () => "stub-model",
        };

        const agentLoop = new AgentLoop(harness, llm, 5);
        harness.agentLoop = agentLoop;

        const sessionId = sessionManager.create({ model: "qwen/qwen3.6-27b" });
        await agentLoop.execute(sessionId, "do the thing", {
            onEvent: (e) => events.push(e),
        });

        // Expected order: stage(memory) → iter 1 → tool_start/end × 4 → iter 2.
        assert.equal(events[0]?.type, "stage", "memory stage leads the stream");
        const iter1 = events[1];
        assert.equal(iter1?.type, "iteration", "iteration follows the stage");
        if (iter1?.type === "iteration") {
            assert.equal(iter1.n, 1, "iteration number reported");
            assert.equal(iter1.max, 5, "iteration total reported");
        }

        const starts = events.filter((e) => e.type === "tool_start");
        const ends = events.filter((e) => e.type === "tool_end");
        assert.equal(starts.length, 4, "one tool_start per tool call");
        assert.equal(ends.length, 4, "one tool_end per tool call");

        const firstStart = starts[0];
        if (firstStart?.type === "tool_start") {
            assert.equal(firstStart.toolName, "fake_tool", "tool_start carries the tool name");
        }

        const end0 = ends[0];
        if (end0?.type === "tool_end") {
            assert.equal(end0.ok, true, "successful tool reports ok=true");
            assert.equal(end0.resultPreview, "done", "result preview attached");
            assert.ok(Number.isFinite(end0.durationMs), "duration attached");
        }
        const end1 = ends[1];
        if (end1?.type === "tool_end") {
            assert.equal(end1.ok, false, "throwing tool reports ok=false");
            assert.equal(end1.resultPreview, "boom", "thrown error preview is the concise message");
        }
        const end2 = ends[2];
        if (end2?.type === "tool_end") {
            assert.equal(end2.ok, false, "shell failure result reports ok=false");
            assert.equal(
                end2.resultPreview,
                "exit code 1\n2 tests failed",
                "shell failure preview is the concise summary"
            );
        }
        const end3 = ends[3];
        if (end3?.type === "tool_end") {
            assert.equal(end3.ok, true, "change tool reports ok=true");
            assert.equal(
                end3.resultPreview,
                changeToolSummary,
                "structured changeSummary surfaces as the feed preview"
            );
        }

        // A tool_end must never precede its tool_start — the UI pairs them and
        // would otherwise keep a ghost live row forever.
        const firstStartIdx = events.findIndex((e) => e.type === "tool_start");
        const firstEndIdx = events.findIndex((e) => e.type === "tool_end");
        assert.ok(firstStartIdx !== -1 && firstStartIdx < firstEndIdx, "tool_end comes after tool_start");

        // The loop must still resolve normally with events enabled.
        assert.equal(calls, 2, "LLM called twice (tools + answer)");

        // ── streaming: assistant text reaches the UI live (Pi-style) ──
        const deltas = events.filter(
            (e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta"
        );
        assert.ok(deltas.length >= 1, "assistant text streams to the UI as deltas");
        assert.equal(
            deltas.map((d) => d.text).join(""),
            "all good",
            "streamed deltas reassemble the final answer"
        );

        console.log("PASS — activity events stream in order with sane previews; text streams live.");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
