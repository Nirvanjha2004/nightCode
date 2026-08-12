// session.check.tsx — assert-based self-check for session / power-user UX.
// Renders the real App with a scripted fake agent loop and a fake session source
// and verifies:
//   • follow-up prompts reuse the SAME session (conversation context preserved);
//   • /clear never reaches the agent loop, swaps the backend session via
//     onResetSession, resets the on-screen conversation, and shows the
//     "Session cleared. Starting a new conversation." transition notice;
//   • the next prompt after /clear runs in the FRESH session;
//   • the status bar shows the current session number (session 1 → session 2);
//   • Esc/Ctrl+C cancellation still works after a reset.
// Run with: bun packages/cli/src/session.check.tsx
import assert from "node:assert/strict";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "./index";
import type { AgentEvent } from "./agent/types";

type FakeLoop = {
    execute: (
        sessionId: string,
        text: string,
        opts: {
            onEvent: (e: AgentEvent) => void;
            signal?: AbortSignal;
        }
    ) => Promise<string>;
    emit: (e: AgentEvent) => void;
    finish: (resp: string) => void;
};

// A fake session source mirroring main.ts: resetSession drops the old session
// and returns the next one. Kept out-of-band so /clear can be verified without
// any real MessageManager/SessionManager (their backend behavior is covered by
// commands.check / cancel.check).
function makeSessionSource() {
    let current = "s1";
    let number = 1;
    const resets: number[] = [];
    return {
        initialSessionId: current,
        initialSessionNumber: number,
        reset: () => {
            current = `s${++number}`;
            resets.push(number);
            return { sessionId: current, sessionNumber: number };
        },
        resetCount: () => resets.length,
        currentId: () => current,
    };
}

function makeLoop(): FakeLoop & { calls: Array<{ sessionId: string; text: string; signal?: AbortSignal }> } {
    const loop = {
        calls: [] as Array<{ sessionId: string; text: string; signal?: AbortSignal }>,
        execute: async (
            sessionId: string,
            text: string,
            opts: { onEvent: (e: AgentEvent) => void; signal?: AbortSignal }
        ) => {
            loop.calls.push({ sessionId, text, signal: opts.signal });
            loop.emit = opts.onEvent;
            return new Promise<string>((resolve, reject) => {
                opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                loop.finish = resolve;
            });
        },
        emit: (_e: AgentEvent) => {},
        finish: (_resp: string) => {},
    };
    return loop;
}

async function main() {
    const sessions = makeSessionSource();
    const loop = makeLoop();

    const setup = await testRender(
        <box width="100%" height="100%">
            <App
                sessionId={sessions.initialSessionId}
                sessionNumber={sessions.initialSessionNumber}
                agentLoop={loop as never}
                commands={[{ name: "clear", description: "Start a fresh session", value: "/clear" }]}
                model="test"
                onResetSession={sessions.reset}
            />
        </box>,
        { width: 80, height: 24, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();

    const frame = () => setup.captureCharFrame();

    // ── session 1 is shown from the start ────────────────────────────────
    assert.ok(frame().includes("session 1"), "status bar shows 'session 1' on first launch");

    // ── 1. follow-ups reuse the SAME session (context preserved) ─────────
    await setup.mockInput.typeText("Inspect the authentication flow.");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    await act(async () => {
        loop.finish("I inspected auth.ts — the token check looks fine.");
    });
    await setup.waitForVisualIdle();

    await setup.mockInput.typeText("Now fix the issue you found.");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    await act(async () => {
        loop.finish("Done.");
    });
    await setup.waitForVisualIdle();

    assert.equal(loop.calls.length, 2, "two prompts submitted");
    assert.equal(loop.calls[0]?.sessionId, "s1", "first prompt uses session s1");
    assert.equal(loop.calls[1]?.sessionId, "s1", "follow-up prompt reuses the SAME session (context preserved)");

    // ── 2. /clear: never reaches the agent, swaps session, resets the UI ──
    await setup.mockInput.typeText("/clear");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();

    assert.equal(loop.calls.length, 2, "/clear is intercepted — the agent loop is never called");
    assert.equal(sessions.resetCount(), 1, "onResetSession was invoked exactly once");
    assert.ok(!frame().includes("Inspect the authentication flow"), "old conversation is gone from the screen");
    assert.ok(
        frame().includes("Session cleared. Starting a new conversation."),
        "the transition notice is shown in the empty new session"
    );
    assert.ok(frame().includes("session 2"), "status bar advances to 'session 2' after /clear");

    // ── 3. the next prompt runs in the FRESH session ─────────────────────
    await setup.mockInput.typeText("Analyze the database layer.");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    await act(async () => {
        loop.finish("The DB layer is in src/db.");
    });
    await setup.waitForVisualIdle();

    assert.equal(loop.calls.length, 3, "third prompt submitted");
    assert.equal(loop.calls[2]?.sessionId, "s2", "post-/clear prompt uses the FRESH session s2");

    // ── 4. Esc/Ctrl+C cancellation still works after a reset ─────────────
    await setup.mockInput.typeText("do something long");
    await setup.mockInput.pressEnter();
    // Wait until the run is visibly active (status bar shows Running) before
    // pressing Ctrl+C — otherwise the keypress can race the loading commit and
    // be treated as a Ctrl+C-while-idle (which exits the app).
    await setup.waitForFrame((f) => f.includes("Running"), { maxPasses: 300 });
    const signal = loop.calls[3]?.signal;
    assert.ok(signal && !signal.aborted, "precondition: run is active and cancellable");
    await setup.mockInput.pressKey("c", { ctrl: true });
    // Flush the abort's microtask chain (reject → cancelled path → loading
    // false) so the input is definitely enabled before typing anything else.
    await act(async () => {});
    await setup.waitForVisualIdle();
    assert.ok(signal?.aborted, "Ctrl+C still aborts the active run after /clear");
    assert.ok(frame().includes("Cancelled"), "status bar shows Cancelled after the abort");

    // ── 5. /clear with trailing text still clears (first-token match) ──
    await setup.mockInput.typeText("/clear please");
    await setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    assert.equal(loop.calls.length, 4, "/clear please never reaches the agent loop");
    assert.equal(sessions.resetCount(), 2, "second reset invoked");
    assert.ok(frame().includes("session 3"), "status bar advances to 'session 3' after /clear please");
    assert.ok(
        frame().includes("Session cleared. Starting a new conversation."),
        "notice shown again after the second reset"
    );

    console.log("PASS — session UX: follow-ups keep context, /clear resets the session safely, notice shown, status bar tracks the session, Ctrl+C still cancels.");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
