// commands.check.ts — tiny assert-based self-check for slash-command logic.
// Run with: bun packages/cli/src/agent/commands.check.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Groq from "groq-sdk";
import { CommandRegistry, resolveSlashCommand } from "./commands";
import { ContextBuilder } from "./context";
import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";
import type { Tool } from "./types";

const dir = mkdtempSync(join(tmpdir(), "commands-check-"));
try {
    // ── Registry: frontmatter parsing, missing dir, malformed files ────────
    writeFileSync(join(dir, "review.md"), `---
description: Review changes
allowed-tools: bash, read, grep
argument-hint: optional scope
---
Run git diff. Do NOT modify files.`);

    writeFileSync(join(dir, "explain.md"), "Explain how $ARGUMENTS works.");

    writeFileSync(join(dir, "notes.txt"), "not a command");

    // malformed YAML — must be logged + skipped, not fatal
    writeFileSync(join(dir, "bad.md"), "---\nfoo: [unclosed\n---\nbody");

    const registry = new CommandRegistry();
    await registry.loadFromDir(dir);

    const review = registry.get("review");
    assert.ok(review, "review should be registered");
    assert.equal(review.description, "Review changes", "description parsed from frontmatter");
    assert.deepEqual(review.allowedTools, ["bash", "read", "grep"], "allowed-tools split + trimmed");
    assert.equal(review.argumentHint, "optional scope", "argument-hint parsed");
    assert.ok(review.body.includes("Run git diff"), "body excludes frontmatter");

    const explain = registry.get("explain");
    assert.ok(explain, "explain should be registered");
    assert.equal(explain.description, undefined, "no frontmatter → no description");
    assert.equal(explain.allowedTools, undefined, "no frontmatter → no tool restriction");
    assert.equal(explain.argumentHint, undefined, "no frontmatter → no argument hint");
    assert.equal(explain.body, "Explain how $ARGUMENTS works.", "no frontmatter → body is full text");

    assert.equal(registry.get("notes"), undefined, "non-.md files are ignored");
    assert.equal(registry.get("bad"), undefined, "malformed file is skipped, not fatal");
    assert.equal(registry.list().length, 2, "list() returns registered commands");

    const missing = new CommandRegistry();
    await missing.loadFromDir(join(tmpdir(), "definitely-missing-" + Date.now()));
    assert.equal(missing.list().length, 0, "missing directory → zero commands, no crash");

    // ── Resolver ────────────────────────────────────────────────────────────
    // normal message
    assert.deepEqual(resolveSlashCommand("hello world", registry), { resolvedInput: "hello world" });

    // known command with arguments
    const resolved = resolveSlashCommand("/explain src/agent/loop.ts", registry);
    assert.equal(resolved.resolvedInput, "Explain how src/agent/loop.ts works.", "$ARGUMENTS substituted");
    assert.equal(resolved.activeCommand?.name, "explain", "active command returned");

    // empty arguments → $ARGUMENTS becomes "", never left literal
    const noArgs = resolveSlashCommand("/explain", registry);
    assert.equal(noArgs.resolvedInput, "Explain how  works.", "empty args → empty substitution");
    assert.ok(!noArgs.resolvedInput.includes("$ARGUMENTS"), "$ARGUMENTS never survives");

    // arguments containing spaces preserved as-is
    const spaced = resolveSlashCommand("/explain src/agent/loop.ts and its tests", registry);
    assert.equal(spaced.resolvedInput, "Explain how src/agent/loop.ts and its tests works.");

    // unknown command → unchanged, no active command, no crash
    const unknown = resolveSlashCommand("/doesnotexist", registry);
    assert.equal(unknown.resolvedInput, "/doesnotexist", "unknown command passes through");
    assert.equal(unknown.activeCommand, undefined);

    // slash-prefixed path (first token not a registered command) → unchanged
    assert.equal(
        resolveSlashCommand("/home/user/project/file.ts", registry).resolvedInput,
        "/home/user/project/file.ts",
        "slash-prefixed paths pass through"
    );

    // multiple $ARGUMENTS occurrences all replaced
    writeFileSync(join(dir, "test.md"), "First: $ARGUMENTS\n\nSecond: $ARGUMENTS");
    const multiRegistry = new CommandRegistry();
    await multiRegistry.loadFromDir(dir);
    const multi = resolveSlashCommand("/test hello world", multiRegistry);
    assert.equal(multi.resolvedInput, "First: hello world\n\nSecond: hello world", "replaceAll semantics");

    // ── Tool filtering ─────────────────────────────────────────────────────
    function fakeTool(name: string): Tool {
        return {
            name,
            description: name,
            parameters: { type: "object", properties: {} },
            exec: async () => "ok",
        };
    }

    const toolRegistry = new ToolRegistry();
    for (const name of ["read", "write", "edit", "grep", "bash"]) {
        toolRegistry.register(fakeTool(name));
    }

    assert.equal(toolRegistry.listFiltered().length, 5, "undefined allowedNames → all tools");
    const filtered = toolRegistry.listFiltered(["read", "grep", "bash"]);
    assert.deepEqual(
        filtered.map((t) => t.name).sort(),
        ["bash", "grep", "read"],
        "allowedNames filters correctly"
    );
    assert.deepEqual(
        toolRegistry.listFiltered(["read", "nope"]).map((t) => t.name),
        ["read"],
        "unknown tool names are ignored, no crash"
    );

    // ── Integration: history stores the raw input, model gets the resolved ──
    // prompt, and only allowed tools are exposed to the model.
    const mm = new MessageManager();
    const sm = new SessionManager();
    const tr = new ToolRegistry();
    for (const name of ["read", "write", "edit", "delete", "grep", "bash"]) {
        tr.register(fakeTool(name));
    }
    // Summarization only triggers past the 100k-token threshold, so this stub
    // is never actually called.
    const cb = new ContextBuilder(mm, sm, tr, {} as unknown as Groq);
    const sessionId = sm.create({ model: "test-model" });

    // simulate AgentLoop.execute's flow for "/review"
    mm.add({ sessionId, role: "user", content: "/review", createdAt: new Date(), messageId: "u1" });
    const { resolvedInput, activeCommand } = resolveSlashCommand("/review", registry);
    const ctx = await cb.build(sessionId, "", activeCommand?.allowedTools, resolvedInput);

    assert.equal(mm.get(sessionId)[0]?.content, "/review", "stored history keeps the original raw input");
    assert.equal(
        ctx.messages[ctx.messages.length - 1]?.content,
        "Run git diff. Do NOT modify files.",
        "model receives the resolved prompt"
    );
    assert.deepEqual(
        ctx.tools.map((t) => t.function?.name).sort(),
        ["bash", "grep", "read"],
        "model only receives the allowed tools"
    );

    // normal messages: no active command → history passed through untouched
    mm.add({ sessionId, role: "user", content: "Fix the login bug.", createdAt: new Date(), messageId: "u2" });
    const ctx2 = await cb.build(sessionId, "");
    assert.equal(
        ctx2.messages[ctx2.messages.length - 1]?.content,
        "Fix the login bug.",
        "normal messages are unchanged"
    );
    assert.equal(ctx2.tools.length, 6, "normal messages expose all tools");

    // ── cwd-independent command discovery ────────────────────────────────
    // Regression: launching from packages/cli resolved "commands" against the
    // wrong cwd and loaded zero commands. Loading from a nested cwd must find
    // the nearest ancestor `commands/` directory by walking up. Self-contained
    // (temp tree) so it never depends on the repo's own commands folder.
    const cmdHome = mkdtempSync(join(tmpdir(), "cmd-home-"));
    const nestedCwd = join(cmdHome, "a", "b");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(join(cmdHome, "commands"));
    writeFileSync(join(cmdHome, "commands", "greet.md"), "Say hi to $ARGUMENTS.");

    const prevCwd = process.cwd();
    try {
        process.chdir(nestedCwd);
        const nestedRegistry = new CommandRegistry();
        await nestedRegistry.loadFromDir("commands");
        assert.equal(nestedRegistry.list().length, 1, "commands resolve from a nested cwd");
        assert.ok(nestedRegistry.get("greet"), "the nearest ancestor commands dir is used");
    } finally {
        process.chdir(prevCwd);
        rmSync(cmdHome, { recursive: true, force: true });
    }

    console.log("PASS — slash command registry, resolver, tool filtering, loop integration, and cwd-independent discovery verified.");
} finally {
    rmSync(dir, { recursive: true, force: true });
}
