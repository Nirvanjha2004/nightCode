// scroll.check.tsx — assert-based self-check for follow-bottom scrolling UX.
// Renders the real App with a scripted fake agent loop and verifies the scrollbox
// follows new output while at the bottom, never yanks the viewport when the user
// has scrolled up, re-engages follow when they return to the bottom, jumps to the
// bottom when a new run starts, and supports keyboard navigation when focused.
// Run with: bun packages/cli/src/scroll.check.tsx
import assert from "node:assert/strict";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ScrollBoxRenderable } from "@opentui/core";
import { App } from "./index";
import type { AgentEvent } from "./agent/types";

type FakeLoop = {
    execute: (sessionId: string, text: string, opts: { onEvent: (e: AgentEvent) => void }) => Promise<string>;
    emit: (e: AgentEvent) => void;
    finish: (resp: string) => void;
};

function findScrollbox(node: unknown): ScrollBoxRenderable | null {
    if (!node || typeof node !== "object") return null;
    const n = node as { scrollTop?: unknown; scrollHeight?: unknown; getChildren?: () => unknown[] };
    if (typeof n.scrollTop === "number" && typeof n.scrollHeight === "number") {
        return n as ScrollBoxRenderable;
    }
    for (const c of (typeof n.getChildren === "function" ? n.getChildren() : [])) {
        const hit = findScrollbox(c);
        if (hit) return hit;
    }
    return null;
}

async function main() {
    const loop: FakeLoop = {
        execute: async (_s, _t, opts) => {
            loop.emit = opts.onEvent;
            return new Promise<string>((resolve) => {
                loop.finish = (resp) => resolve(resp);
            });
        },
        emit: () => {},
        finish: () => {},
    };

    const setup = await testRender(
        <box width="100%" height="100%">
            <App sessionId="s1" agentLoop={loop as never} commands={[]} model="test" />
        </box>,
        { width: 60, height: 20 }
    );
    await setup.waitForVisualIdle();

    const sb = () => {
        const s = findScrollbox(setup.renderer.root);
        assert.ok(s, "scrollbox must be mounted");
        return s;
    };
    const maxTop = (s: ScrollBoxRenderable) => Math.max(0, s.scrollHeight - s.viewport.height);

    // ── run 1: new run starts at bottom and follows output ─────────────
    await setup.mockInput.typeText("do the thing");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    assert.equal(sb().scrollTop, maxTop(sb()), "new run starts at the bottom (following)");

    for (let i = 0; i < 8; i++) {
        await act(async () => {
            loop.emit({ type: "tool_start", toolName: "read", argsPreview: `src/${i}.ts` });
            loop.emit({ type: "tool_end", toolName: "read", ok: true, durationMs: 100, resultPreview: `file ${i} contents` });
        });
        await setup.waitForVisualIdle();
    }
    assert.equal(sb().scrollTop, maxTop(sb()), "output follows the bottom while the user is at the bottom");

    // ── scroll up with the wheel → follow disengages ───────────────────
    await setup.mockMouse.scroll(30, 10, "up", { delayMs: 20 });
    await setup.waitForVisualIdle();
    assert.ok(sb().scrollTop < maxTop(sb()), "wheel-up scrolls away from the bottom");

    const readingTop = sb().scrollTop;
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            loop.emit({ type: "tool_start", toolName: "write", argsPreview: `src/x${i}.ts` });
            loop.emit({ type: "tool_end", toolName: "write", ok: true, durationMs: 100, resultPreview: `wrote ${i}` });
        });
        await setup.waitForVisualIdle();
    }
    assert.equal(sb().scrollTop, readingTop, "new output does NOT yank the viewport while reading older output");
    assert.ok(maxTop(sb()) > readingTop, "content grew underneath the reader");

    // ── finish the run with a large markdown response ──────────────────
    await act(async () => {
        loop.finish("# Done\n\n" + Array.from({ length: 15 }, (_, i) => `- item ${i}`).join("\n"));
    });
    await setup.waitForVisualIdle();
    assert.equal(sb().scrollTop, readingTop, "a large final response still does not yank the viewport");

    // ── scroll back to the bottom → follow re-engages ──────────────────
    for (let guard = 0; guard < 120 && sb().scrollTop < maxTop(sb()); guard++) {
        await setup.mockMouse.scroll(30, 10, "down", { delayMs: 2 });
    }
    await setup.waitForVisualIdle();
    assert.equal(sb().scrollTop, maxTop(sb()), "scrolling back down reaches the bottom");
    await act(async () => {
        loop.emit({ type: "tool_end", toolName: "git_diff", ok: true, durationMs: 200, resultPreview: "diff summary" });
    });
    await setup.waitForVisualIdle();
    assert.equal(sb().scrollTop, maxTop(sb()), "follow re-engages once the user is back at the bottom");

    // ── run 2: a new run jumps to the bottom even after scrolling up ───
    await setup.mockMouse.scroll(30, 10, "up", { delayMs: 20 });
    await setup.waitForVisualIdle();
    assert.ok(sb().scrollTop < maxTop(sb()), "precondition: user is scrolled up");
    await setup.mockInput.typeText("second task");
    await setup.mockInput.pressEnter();
    // The jump happens on the commit + next layout pass — poll for it.
    await setup.waitForFrame(() => sb().scrollTop === maxTop(sb()), { maxPasses: 300 });
    assert.equal(sb().scrollTop, maxTop(sb()), "a new run starts at the bottom again");
    await act(async () => {
        loop.emit({ type: "tool_end", toolName: "grep", ok: true, durationMs: 50, resultPreview: "hit" });
    });
    await setup.waitForVisualIdle();
    assert.equal(sb().scrollTop, maxTop(sb()), "run 2 follows its output");
    await act(async () => {
        loop.finish("done");
    });
    await setup.waitForVisualIdle();

    // ── keyboard navigation (framework-supported keys, scrollbox focused) ──
    // Last section: focusing the scrollbox steals focus from the input, so nothing
    // that needs typing may follow it.
    sb().focus();
    await setup.mockInput.pressKey("HOME");
    await setup.waitForVisualIdle();
    assert.equal(sb().scrollTop, 0, "Home scrolls to the top");
    await setup.mockInput.pressKey("END");
    await setup.waitForFrame(() => sb().scrollTop === maxTop(sb()), { maxPasses: 300 });
    assert.equal(sb().scrollTop, maxTop(sb()), "End scrolls to the bottom and re-engages follow");
    await setup.mockInput.pressKey("ARROW_UP");
    await setup.waitForVisualIdle();
    assert.ok(sb().scrollTop < maxTop(sb()), "ArrowUp scrolls up by a step");
    await setup.mockInput.pressKey("PAGE_DOWN");
    await setup.waitForVisualIdle();
    assert.ok(sb().scrollTop >= 0, "PageDown scrolls without error");
    await setup.mockInput.pressKey("PAGE_UP");
    await setup.waitForVisualIdle();
    assert.ok(sb().scrollTop < maxTop(sb()), "PageUp scrolls up");

    console.log("PASS — follow-bottom scrolling: follows at bottom, no forced jumps, re-engages, new runs start at bottom, keyboard nav works.");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
