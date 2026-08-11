// width.check.tsx — assert-based self-check for narrow-terminal / resize layout.
// Renders the real App with a scripted fake agent loop and verifies:
//   • no row ever exceeds the terminal width (no horizontal overflow), from a
//     normal 120-col terminal down to a 20-col one;
//   • the status bar stays on ONE row and its state label stays fully readable
//     ("Ready") on narrow terminals — the model/path absorb the shrink;
//   • the header hides its version meta below the width where it would collide
//     with the ASCII-art brand, and shows it again on resize back up;
//   • resizing while following the bottom keeps the viewport at the bottom;
//   • resizing while the user is scrolled up does NOT yank the viewport;
//   • a pending destructive-action confirm wraps its long args preview instead
//     of clipping, and never overflows;
//   • nothing crashes at very narrow widths (graceful degradation).
// Run with: bun packages/cli/src/width.check.tsx
import assert from "node:assert/strict";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ScrollBoxRenderable } from "@opentui/core";
import { App } from "./index";
import type { AgentEvent } from "./agent/types";

type FakeLoop = {
    execute: (
        sessionId: string,
        text: string,
        opts: {
            onEvent: (e: AgentEvent) => void;
            confirmHook: (msg: string, tool: string, args: Record<string, unknown>) => Promise<boolean>;
        }
    ) => Promise<string>;
    emit: (e: AgentEvent) => void;
    finish: (resp: string) => void;
    /** The real confirm hook the App handed to execute — captured for tests. */
    confirm: (msg: string, tool: string, args: Record<string, unknown>) => Promise<boolean>;
};

const MARKDOWN = [
    "# Authentication",
    "",
    "The issue is in **auth.ts**. Run `npm test` before committing.",
    "",
    "```ts",
    "const token = getToken();",
    "if (!token) {",
    "    return unauthorized();",
    "}",
    "```",
    "",
    "Changes:",
    "- Fixed authentication with a very long description that should wrap on narrow terminals",
    "- Added validation",
    "",
    "A paragraph that is intentionally long enough to wrap across several lines on a narrow terminal so it stays readable.",
].join("\n");

const LONG_DIFF_PREVIEW =
    "diff --git a/src/auth.ts b/src/auth.ts index 1234567..89abcde 100644 --- a/src/auth.ts +++ b/src/auth.ts @@ -1,7 +1,9 @@ the diff content line that is extremely long and should never break the layout";

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

function makeLoop(): FakeLoop {
    const loop = {
        execute: async (_s: string, _t: string, opts: { onEvent: (e: AgentEvent) => void; confirmHook: (msg: string, tool: string, args: Record<string, unknown>) => Promise<boolean> }) => {
            loop.emit = opts.onEvent;
            loop.confirm = opts.confirmHook;
            return new Promise<string>((resolve) => {
                loop.finish = resolve;
            });
        },
        emit: (_e: AgentEvent) => {},
        finish: (_resp: string) => {},
        confirm: async (_msg: string, _tool: string, _args: Record<string, unknown>): Promise<boolean> => false,
    } satisfies FakeLoop;
    return loop;
}

async function renderApp(width: number, height: number) {
    const loop = makeLoop();
    const setup = await testRender(
        <box width="100%" height="100%">
            <App sessionId="s1" agentLoop={loop as never} commands={[]} model="groq/llama-3.3-70b" />
        </box>,
        { width, height }
    );
    await setup.waitForVisualIdle();
    return { loop, setup };
}

function assertNoOverflow(frame: string, width: number, label: string) {
    const lines = frame.split("\n");
    for (const [i, line] of lines.entries()) {
        assert.ok(line.length <= width, `${label}: row ${i} exceeds terminal width (${line.length} > ${width}): ${JSON.stringify(line)}`);
    }
}

function countRowsContaining(frame: string, needle: string): number {
    return frame.split("\n").filter((l) => l.includes(needle)).length;
}

// ── populate a completed run: user msg + activity + live tool + diff + markdown ──
async function runToCompletion({ loop, setup }: { loop: FakeLoop; setup: Awaited<ReturnType<typeof renderApp>>["setup"] }) {
    await act(async () => {
        loop.emit({ type: "stage", name: "memory" });
        loop.emit({ type: "iteration", n: 1, max: 3 });
        loop.emit({ type: "tool_start", toolName: "bash", argsPreview: "run_a_very_long_command_with_lots_of_arguments --flag --verbose --output=path/to/something" });
    });
    await setup.waitForVisualIdle();
    await setup.mockInput.typeText("please fix the authentication bug");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    await act(async () => {
        loop.emit({ type: "tool_end", toolName: "git_diff", ok: true, durationMs: 1234, resultPreview: LONG_DIFF_PREVIEW });
        loop.finish(MARKDOWN);
    });
    await setup.waitForVisualIdle();
}

async function main() {
    // ── 1. No horizontal overflow at any width; status bar stays one line ──
    for (const [width, height] of [
        [120, 30] as const,
        [60, 24] as const,
        [40, 20] as const,
        [30, 18] as const,
        [20, 15] as const,
    ]) {
        const { loop, setup } = await renderApp(width, height);
        await runToCompletion({ loop, setup });
        const frame = setup.captureCharFrame();
        assertNoOverflow(frame, width, `${width}x${height}`);
        // Status label fully readable on ONE row (never split / wrapped to a 2nd row).
        assert.equal(
            countRowsContaining(frame, "Ready"),
            1,
            `${width}x${height}: status label 'Ready' must appear on exactly one row`
        );
        // Header meta: visible when there is room, hidden when it would collide with the brand.
        if (width >= 80) {
            assert.ok(frame.includes("v1.0.0"), `${width}x${height}: header meta should be visible at ${width} cols`);
        } else {
            assert.ok(!frame.includes("v1.0.0"), `${width}x${height}: header meta should be hidden at ${width} cols`);
        }
    }

    // ── 1b. Resize across the header-meta threshold: meta hides and returns live ──
    {
        const { setup } = await renderApp(80, 20);
        assert.ok(setup.captureCharFrame().includes("v1.0.0"), "header meta visible at 80 cols");
        setup.resize(60, 20);
        await setup.waitForVisualIdle();
        assert.ok(!setup.captureCharFrame().includes("v1.0.0"), "header meta hides when resized to 60 cols");
        setup.resize(80, 20);
        await setup.waitForVisualIdle();
        assert.ok(setup.captureCharFrame().includes("v1.0.0"), "header meta returns when resized back to 80 cols");
    }

    // ── 2. Empty state at a very narrow width does not overflow or crash ──
    {
        const { setup } = await renderApp(20, 12);
        const frame = setup.captureCharFrame();
        assertNoOverflow(frame, 20, "empty 20x12");
    }

    // ── 3. Resize while following the bottom keeps the viewport at the bottom ──
    {
        const { loop, setup } = await renderApp(80, 24);
        await setup.mockInput.typeText("do the thing");
        await setup.mockInput.pressEnter();
        await setup.waitForVisualIdle();
        for (let i = 0; i < 8; i++) {
            await act(async () => {
                loop.emit({ type: "tool_start", toolName: "read", argsPreview: `src/${i}.ts` });
                loop.emit({ type: "tool_end", toolName: "read", ok: true, durationMs: 100, resultPreview: `file ${i} contents` });
            });
            await setup.waitForVisualIdle();
        }
        const sb = () => {
            const s = findScrollbox(setup.renderer.root);
            assert.ok(s, "scrollbox must be mounted");
            return s;
        };
        const maxTop = (s: ScrollBoxRenderable) => Math.max(0, s.scrollHeight - s.viewport.height);
        assert.equal(sb().scrollTop, maxTop(sb()), "precondition: following the bottom");

        // shrink the terminal while running
        setup.resize(40, 16);
        await setup.waitForVisualIdle();
        assert.equal(sb().scrollTop, maxTop(sb()), "resize smaller keeps the bottom in view");
        // grow it back
        setup.resize(100, 30);
        await setup.waitForVisualIdle();
        assert.equal(sb().scrollTop, maxTop(sb()), "resize larger keeps the bottom in view");
        // follow-bottom still engages on new output after the resize
        await act(async () => {
            loop.emit({ type: "tool_end", toolName: "grep", ok: true, durationMs: 50, resultPreview: "hit" });
        });
        await setup.waitForVisualIdle();
        assert.equal(sb().scrollTop, maxTop(sb()), "follow-bottom works after resize");
    }

    // ── 4. Resize while scrolled away does NOT yank the viewport ──
    {
        const { loop, setup } = await renderApp(80, 24);
        await runToCompletion({ loop, setup });
        // grow the content a lot so the reading position stays far from the bottom
        for (let i = 0; i < 30; i++) {
            await act(async () => {
                loop.emit({ type: "tool_end", toolName: "read", ok: true, durationMs: 100, resultPreview: `file ${i}: a long-ish preview line that wraps onto a couple of rows of content` });
            });
            await setup.waitForVisualIdle();
        }
        const sb = () => {
            const s = findScrollbox(setup.renderer.root);
            assert.ok(s, "scrollbox must be mounted");
            return s;
        };
        const maxTop = (s: ScrollBoxRenderable) => Math.max(0, s.scrollHeight - s.viewport.height);

        // scroll well up, away from the bottom
        for (let guard = 0; guard < 60 && sb().scrollTop > maxTop(sb()) * 0.4; guard++) {
            await setup.mockMouse.scroll(30, 10, "up", { delayMs: 2 });
        }
        await setup.waitForVisualIdle();
        const readingTop = sb().scrollTop;
        assert.ok(readingTop < maxTop(sb()), "precondition: user scrolled up away from the bottom");

        // shrink and grow — the reading position must not be yanked to the bottom
        setup.resize(50, 18);
        await setup.waitForVisualIdle();
        assert.ok(sb().scrollTop < maxTop(sb()), "resize while reading does not jump to the bottom");
        setup.resize(110, 28);
        await setup.waitForVisualIdle();
        assert.ok(sb().scrollTop < maxTop(sb()), "grow while reading does not jump to the bottom");
        assert.ok(sb().scrollTop <= maxTop(sb()), "scrollTop never exceeds the max");
    }

    // ── 5. Confirm dialog wraps its long args preview and never overflows ──
    {
        const { loop, setup } = await renderApp(40, 40);
        await setup.mockInput.typeText("delete the database");
        await setup.mockInput.pressEnter();
        await setup.waitForVisualIdle();
        await act(async () => {
            void loop.confirm("Are you sure?", "del", {
                path: "C:/Users/nirva/Desktop/nightCode/packages/cli/src/agent/tools.ts",
                recursive: true,
                force: true,
                description: "Deletes the entire database directory permanently",
            });
        });
        await act(async () => {});
        await setup.waitForVisualIdle();
        const frame = setup.captureCharFrame();
        assertNoOverflow(frame, 40, "confirm 40x40");
        // If the preview were clipped to one row, only "del({"path":"C:/Users/nirva/"
        // would be visible — seeing the continuation ("Desktop/nightCode") on a later
        // row proves the long preview wrapped instead of being cut off mid-token.
        assert.ok(
            frame.includes("del({") && frame.includes("Desktop/nightCode"),
            "long args preview wraps onto a continuation row instead of clipping at the first line"
        );

        // graceful on a tight terminal: no crash, no overflow
        const tight = await renderApp(30, 20);
        await tight.setup.mockInput.typeText("delete the database");
        await tight.setup.mockInput.pressEnter();
        await tight.setup.waitForVisualIdle();
        await act(async () => {
            void tight.loop.confirm("Are you sure?", "del", { path: "/x/y/z", recursive: true });
        });
        await act(async () => {});
        await tight.setup.waitForVisualIdle();
        assertNoOverflow(tight.setup.captureCharFrame(), 30, "confirm 30x20");
    }

    console.log("PASS — narrow/resize layout: no overflow at any width, one-line status bar, header meta hides on narrow, resize keeps follow-bottom, scrolled-away viewport not yanked, confirm wraps.");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
