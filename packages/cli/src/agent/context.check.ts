// context.check.ts — assert-based self-check for the Pi-style prompt + tool surface.
// Verifies: the model-visible surface is exactly the 9 tools (Pi's 7 plus
// todoWrite and spawn_subagent); hidden tools (append, delete, mkdir, glob,
// rename, copy) are neither advertised in the prompt nor present in the tool
// list; the prompt's "Available tools" mirrors the actual surface; memory
// context is still injected; and allowedTools scoping still applies on top.
// Run with: bun packages/cli/src/agent/context.check.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";
import { ContextBuilder } from "./context";
import {
    read, write, edit, bash, grep, find, ls, todoWrite, spawnSubagent,
    append, del, makeDir, globTool, renameTool, copy,
} from "./tools";
import type { ChatLLM } from "../llm-client/types";

const VISIBLE = ["read", "write", "edit", "bash", "grep", "find", "ls", "todoWrite", "spawn_subagent"];
const HIDDEN = ["append", "delete", "mkdir", "glob", "rename", "copy"];

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "context-check-"));
    try {
        const messageManager = new MessageManager();
        const sessionManager = new SessionManager();
        const toolRegistry = new ToolRegistry();
        for (const tool of [read, write, edit, bash, grep, find, ls, todoWrite, spawnSubagent, append, del, makeDir, globTool, renameTool, copy]) {
            toolRegistry.register(tool);
        }
        const llm: ChatLLM = {
            chat: async () => ({ type: "text", content: "stub" }),
            summarizerModel: () => "stub-model",
            contextLimit: () => 131_072,
            subagentModel: () => "stub-model",
        };
        const builder = new ContextBuilder(messageManager, sessionManager, toolRegistry, llm);
        const sessionId = sessionManager.create({ model: "qwen/qwen3.6-27b" });
        messageManager.add({ messageId: "m1", sessionId, role: "user", content: "hello", createdAt: new Date() });

        const ctx = await builder.build(sessionId, "## Known facts\n- x");

        // ── model-visible surface ──────────────────────────────────────
        const names = ctx.tools.map((t) => t.function.name);
        assert.equal(ctx.tools.length, 9, "model sees exactly the 9-tool Pi-style surface");
        for (const name of VISIBLE) assert.ok(names.includes(name), `surface includes ${name}`);
        for (const name of HIDDEN) {
            assert.ok(!names.includes(name), `hidden tool ${name} is not in the tool list`);
            assert.ok(!ctx.systemPrompt.includes(`- ${name}:`), `hidden tool ${name} is not advertised in the prompt`);
        }

        // ── prompt mirrors the actual surface ──────────────────────────
        assert.ok(ctx.systemPrompt.includes("Available tools:"), "prompt lists available tools");
        for (const tool of ctx.tools) {
            assert.ok(
                ctx.systemPrompt.includes(`- ${tool.function.name}:`),
                `prompt carries a one-line snippet for ${tool.function.name}`
            );
        }
        assert.ok(ctx.systemPrompt.includes("Current working directory:"), "prompt carries the working directory");
        assert.ok(ctx.systemPrompt.includes("## Known facts"), "memory context is still injected");
        assert.ok(ctx.systemPrompt.length < 2500, `prompt stays compact (${ctx.systemPrompt.length} chars)`);
        assert.ok(!ctx.systemPrompt.includes("Core Principles"), "old verbose prompt sections are gone");
        assert.equal(
            ctx.systemPrompt.match(/Current working directory: /g)?.length,
            1,
            "prompt carries exactly one working-directory line"
        );

        // ── allowedTools scoping still applies on top of the surface ──
        const scoped = await builder.build(sessionId, "", ["read", "grep"]);
        assert.deepEqual(
            scoped.tools.map((t) => t.function.name).sort(),
            ["grep", "read"],
            "allowedTools scope still enforced"
        );

        console.log("PASS — Pi-style surface (9 tools), prompt mirrors it, hidden tools stay hidden, memory injected.");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
