import { useState, useCallback, useRef, useEffect } from "react";
import { Header } from "./header";
import { InputBar } from "./input-bar";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import "../telemetry";
import type { AgentLoop } from "../agent/loop";
import type { AgentEvent, ConfirmHook } from "../agent/types";
import type { Command } from "./commands-menu/types";
import type { AgentStatus } from "./status-bar";
import type { ModelMenuData } from "./model-menu/types";
import { logger } from "../logger";
import { MarkdownContent, type MdPalette } from "./markdown";
// Display-only — agent context lives in backend MessageManager, not here
type DisplayMessage = {
    id: string;
    role: "user" | "assistant" | "error";
    content: string;
};

type Props = {
    sessionId: string;
    /** Human-friendly session counter (1, 2, …) — shown in the status bar. */
    sessionNumber: number;
    agentLoop: AgentLoop;
    model: string;
    /** Slash commands loaded from the backend registry, suggested while typing. */
    commands: Command[];
    /** /clear — swap to a fresh backend session; returns the new session identity. */
    onResetSession: () => { sessionId: string; sessionNumber: number };
    /** Active provider id — enables the ✓ marker in the model selector. */
    providerId?: string;
    /** Build the model-selector data; when present (with onSwitchModel), Ctrl+M opens the menu. */
    getModelOptions?: () => ModelMenuData;
    /** Called when the user picks a provider/model — swaps the backend router. */
    onSwitchModel?: (providerId: string, modelId: string) => { providerId: string; modelId: string };
};

// ── Color palette (Catppuccin Mocha inspired) ─────────────────────────────────
const C = {
    bg: "#0D0D12",
    surface0: "#13131A",
    surface1: "#1A1A24",
    surface2: "#222233",
    overlay0: "#2A2A3A",
    overlay1: "#3A3A4A",
    subtitle: "#6B6B7B",
    text: "#CDD6F4",
    blue: "#89B4FA",
    green: "#A6E3A1",
    red: "#F38BA8",
    yellow: "#F9E2AF",
    mauve: "#CBA6F7",
    peach: "#FAB387",
    teal: "#94E2D5",
};

// ── Markdown palette for assistant replies (shared with markdown.tsx) ──────────
const MD_PALETTE: MdPalette = {
    text: C.text,
    blue: C.blue,
    teal: C.teal,
    peach: C.peach,
    surface1: C.surface1,
    surface2: C.surface2,
};

// ── Role label config ─────────────────────────────────────────────────────────
const ROLE_CONFIG: Record<DisplayMessage["role"], { label: string; fg: string; bg: string; border: string }> = {
    user: { label: "You", fg: C.blue, bg: "#15152A", border: C.blue },
    assistant: { label: "NightCode", fg: C.green, bg: "#15251A", border: C.green },
    error: { label: "Error", fg: C.red, bg: "#2A1515", border: C.red },
};

// ── Confirmation dialog ────────────────────────────────────────────────────────
type PendingConfirm = {
    resolve: (value: boolean) => void;
    message: string;
    toolName: string;
    args: Record<string, unknown>;
};

function ConfirmDialog({ pending }: { pending: PendingConfirm }) {
    const argsStr = JSON.stringify(pending.args).slice(0, 200);

    return (
        <box paddingX={2} paddingY={1} flexDirection="column">
            <box
                border={true}
                borderStyle="rounded"
                borderColor={C.peach}
                backgroundColor="#1A1A15"
                padding={1}
                flexDirection="column"
                gap={1}
            >
                {/* Header */}
                <box flexDirection="row" gap={1} alignItems="center">
                    <text fg={C.peach}>⚠</text>
                    <text attributes={TextAttributes.BOLD} fg={C.peach}>
                        Destructive Action
                    </text>
                </box>

                {/* Tool info — use a single text element with interpolated string.
                    wrapMode="word" keeps long args previews readable (wrapped) on
                    narrow terminals instead of clipping mid-line. */}
                <box paddingX={1}>
                    <text fg={C.text} wrapMode="word">
                        {pending.toolName}({argsStr})
                    </text>
                </box>

                {/* Instructions */}
                <box paddingX={1} flexDirection="row" gap={1}>
                    <text fg={C.green} attributes={TextAttributes.BOLD}>[Y]</text>
                    <text fg={C.subtitle}>Confirm and execute</text>
                </box>
                <box paddingX={1} flexDirection="row" gap={1}>
                    <text fg={C.red} attributes={TextAttributes.BOLD}>[N]</text>
                    <text fg={C.subtitle}>Cancel this operation</text>
                </box>
                <box paddingX={1} flexDirection="row" gap={1}>
                    <text fg={C.overlay1} attributes={TextAttributes.DIM}>[Esc]</text>
                    <text fg={C.subtitle}>Cancel operation (same as N)</text>
                </box>
            </box>
        </box>
    );
}

// ── Simple animated dots component ────────────────────────────────────────────
function ThinkingIndicator() {
    const [dots, setDots] = useState("");

    useEffect(() => {
        const t = setInterval(() => {
            setDots((d) => (d.length >= 3 ? "" : d + "."));
        }, 400);
        return () => clearInterval(t);
    }, []);

    return (
        <box flexDirection="row" gap={1}>
            <text fg={C.yellow} attributes={TextAttributes.DIM}>
                Thinking{dots}
            </text>
        </box>
    );
}

// ── Agent activity feed — shows what the loop is doing (Issue #1) ─────────────
const STAGE_LABELS: Record<string, string> = {
    memory: "loading memory",
    extract: "saving memories",
};

// A second cancellation within this window exits the app (^C^C), mirroring the
// old Ctrl+C-exits-everything behavior without killing the process mid-run.
const CANCEL_TO_EXIT_MS = 2000;

function StageRow({ name }: { name: string }) {
    return (
        <text fg={C.overlay1} attributes={TextAttributes.DIM}>
            · {STAGE_LABELS[name] ?? name}
        </text>
    );
}

function IterationRow({ n, max }: { n: number; max: number }) {
    return (
        <text fg={C.overlay1} attributes={TextAttributes.DIM}>
            · iter {n}/{max}
        </text>
    );
}

function ToolEndRow({ event }: { event: Extract<AgentEvent, { type: "tool_end" }> }) {
    return (
        <box flexDirection="column">
            <text fg={event.ok ? C.green : C.red} attributes={event.ok ? undefined : TextAttributes.BOLD}>
                {event.ok ? "✓" : "✗"} {event.toolName} · {(event.durationMs / 1000).toFixed(1)}s
            </text>
            {event.resultPreview && (
                <text fg={C.subtitle} attributes={TextAttributes.DIM} wrapMode="word">
                    {event.resultPreview}
                </text>
            )}
        </box>
    );
}

// ── Message bubble component ───────────────────────────────────────────────────
export function MessageBubble({ msg }: { msg: DisplayMessage }) {
    const cfg = ROLE_CONFIG[msg.role];
    const isUser = msg.role === "user";

    return (
        <box
            flexDirection="column"
            alignItems={isUser ? "flex-end" : "flex-start"}
            paddingX={2}
        >
            {/* Role label chip */}
            <box
                border={true}
                borderStyle="rounded"
                borderColor={cfg.border}
                backgroundColor={cfg.bg}
                maxWidth="80%"
                flexDirection="column"
            >
                {/* Header row: label + time placeholder */}
                <box
                    paddingX={1}
                    paddingTop={1}
                    flexDirection="row"
                    gap={1}
                    alignItems="center"
                >
                    <text
                        attributes={TextAttributes.BOLD}
                        fg={cfg.fg}
                    >
                        {cfg.label}
                    </text>
                    <text
                        attributes={TextAttributes.DIM}
                        fg={C.subtitle}
                    >
                        •
                    </text>
                    <text
                        attributes={TextAttributes.DIM}
                        fg={C.overlay1}
                    >
                        just now
                    </text>
                </box>

                {/* Message content — assistant replies render as markdown */}
                <box paddingX={1} paddingY={1}>
                    {msg.role === "assistant" ? (
                        <MarkdownContent content={msg.content} palette={MD_PALETTE} />
                    ) : (
                        <text fg={C.text} wrapMode="word">
                            {msg.content}
                        </text>
                    )}
                </box>
            </box>
        </box>
    );
}

// ── Main App ───────────────────────────────────────────────────────────────────
// The working directory NightCode was launched from — constant for the session.
const CWD = process.cwd();

export function App({ sessionId: initialSessionId, sessionNumber: initialSessionNumber, agentLoop, commands, model: initialModel, onResetSession, providerId: initialProviderId, getModelOptions, onSwitchModel }: Props) {
    // The current session is owned here so /clear can swap it without re-mounting
    // the whole app (the backend swap happens in main via onResetSession).
    const [sessionId, setSessionId] = useState(initialSessionId);
    const [sessionNumber, setSessionNumber] = useState(initialSessionNumber);
    // The active model/provider — updated when the user switches via Ctrl+M so
    // the status bar and the ✓ marker track the backend router's state.
    const [model, setModel] = useState(initialModel);
    const [providerId, setProviderId] = useState(initialProviderId ?? "");
    // One-shot transition notice shown in the empty state after /clear.
    const [notice, setNotice] = useState<string | null>(null);
    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<AgentStatus>("ready");
    const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
    const pendingRef = useRef(pendingConfirm);
    pendingRef.current = pendingConfirm;
    const loadingRef = useRef(loading);
    loadingRef.current = loading;
    const abortRef = useRef<AbortController | null>(null);
    const lastCancelTsRef = useRef(0);
    const renderer = useRenderer();
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);

    const push = (role: DisplayMessage["role"], content: string) => {
        setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role, content },
        ]);
    };

    // ── Scroll following ─────────────────────────────────────────────
    // The scrollbox's stickyScroll handles follow-bottom natively (it stops
    // following once the user scrolls away and re-engages when they return to
    // the bottom). The one gap: starting a new run must jump to the bottom even
    // if the user had scrolled up during a previous run — otherwise the new
    // prompt/response would land out of view. Jumping also re-engages follow.
    useEffect(() => {
        if (loading) {
            const sb = scrollRef.current;
            // scrollTop clamps to max, and the setter re-syncs the follow state.
            // If the jump lands a frame before the new message is measured,
            // stickyScroll self-corrects to the new bottom on the next layout.
            if (sb) sb.scrollTop = sb.scrollHeight;
        }
    }, [loading]);

    // ── Agent activity feed ──────────────────────────────────────────
    const [activity, setActivity] = useState<AgentEvent[]>([]);
    const [liveTool, setLiveTool] = useState<{ toolName: string; argsPreview: string; startedAt: number } | null>(null);
    const [liveElapsed, setLiveElapsed] = useState(0);
    // Live assistant reply — appended as text_delta events arrive (Pi-style
    // streaming). Rendered in the same slot the final message lands in, then
    // replaced by it when the run resolves.
    const [streaming, setStreaming] = useState<{ id: string; text: string } | null>(null);

    // Tick the live tool row's elapsed counter once a second.
    useEffect(() => {
        if (!liveTool) return;
        const t = setInterval(() => setLiveElapsed(Math.floor((Date.now() - liveTool.startedAt) / 1000)), 1000);
        return () => clearInterval(t);
    }, [liveTool]);

    // Stream events from the loop into the feed. tool_start becomes the live
    // row (tools run sequentially, so at most one is live); tool_end finalizes it.
    const handleAgentEvent = useCallback((event: AgentEvent) => {
        if (event.type === "tool_start") {
            setLiveTool({ toolName: event.toolName, argsPreview: event.argsPreview, startedAt: Date.now() });
            return;
        }
        if (event.type === "tool_end") {
            setLiveTool(null);
            setActivity((prev) => [...prev, event]);
            return;
        }
        if (event.type === "cancelled") {
            // A cancelled run may have left a ghost live-tool row — clear it.
            setLiveTool(null);
            setActivity((prev) => [...prev, event]);
            return;
        }
        if (event.type === "text_delta") {
            // Append to the live assistant bubble (create it on first delta).
            setStreaming((prev) => ({
                id: prev?.id ?? crypto.randomUUID(),
                text: (prev?.text ?? "") + event.text,
            }));
            return;
        }
        setActivity((prev) => [...prev, event]);
    }, []);

    // ── Cancellation ────────────────────────────────────────────────────
    // Esc or the first Ctrl+C while a run is active cancels it (the run stays
    // in the same session, input re-enables). Only ^C^C — a second Ctrl+C
    // within the 2s window — exits the app normally; Esc never advances the
    // exit window. Ctrl+C while idle also exits (old behavior).
    const cancelRun = useCallback((fromCtrlC: boolean) => {
        if (fromCtrlC) {
            const now = Date.now();
            if (lastCancelTsRef.current && now - lastCancelTsRef.current <= CANCEL_TO_EXIT_MS) {
                logger.info("[UI] Double Ctrl+C — exiting");
                process.nextTick(() => renderer.destroy());
                return;
            }
            lastCancelTsRef.current = now;
        }
        logger.info("[UI] Cancelling active agent run");
        // Unblock a pending destructive-action confirmation so the loop observes
        // the abort instead of waiting on the dialog forever.
        pendingRef.current?.resolve(false);
        setPendingConfirm(null);
        abortRef.current?.abort();
    }, [renderer]);

    // ── Keyboard handler ────────────────────────────────────────────────
    // 1. Confirmation dialog open → Y/N/Esc keep their existing behavior;
    //    Ctrl+C cancels the whole run (not just the operation).
    // 2. Otherwise → Esc cancels an active run; Ctrl+C cancels an active run
    //    (second press within 2s exits) or exits when idle.
    // Use refs to avoid stale closures (useKeyboard may capture the handler once).
    useKeyboard((keyEvent) => {
        const p = pendingRef.current;
        const isCtrlC = keyEvent.ctrl && !keyEvent.shift && keyEvent.name === "c";

        if (p) {
            // Y → confirm
            if (keyEvent.name === "y") {
                logger.info(`[UI] User confirmed: ${p.toolName}`);
                p.resolve(true);
                setPendingConfirm(null);
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            // N or Escape → reject
            if (keyEvent.name === "n" || keyEvent.name === "escape") {
                logger.info(`[UI] User rejected: ${p.toolName}`);
                p.resolve(false);
                setPendingConfirm(null);
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            // Ctrl+C while a confirmation is up → cancel the run itself.
            if (isCtrlC) {
                cancelRun(true);
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
            }
            return;
        }

        // ── Cancellation keys (no dialog open) ──
        if (isCtrlC) {
            if (loadingRef.current) {
                cancelRun(true);
            } else {
                logger.info("[UI] Ctrl+C while idle — exiting");
                process.nextTick(() => renderer.destroy());
            }
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            return;
        }

        if (keyEvent.name === "escape" && loadingRef.current) {
            cancelRun(false);
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
        }
    });

    // ── Model switching (Ctrl+M) ────────────────────────────────────────
    const handleModelSelect = useCallback(
        (nextProviderId: string, modelId: string) => {
            if (!onSwitchModel) return;
            const next = onSwitchModel(nextProviderId, modelId);
            if (next) {
                setModel(next.modelId);
                setProviderId(next.providerId);
            }
        },
        [onSwitchModel]
    );

    // ── Build the confirm hook for the agent loop ─────────────────────
    const buildConfirmHook = useCallback((): ConfirmHook => {
        return async (_msg: string, toolName: string, args: Record<string, unknown>): Promise<boolean> => {
            return new Promise<boolean>((resolve) => {
                setPendingConfirm({ resolve, message: _msg, toolName, args });
            });
        };
    }, []);

    const handleSubmit = useCallback(async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || loading) return;

        // ── /clear — start a fresh session (UI command; never reaches the agent) ──
        // The backend swaps to a brand-new session (fresh message history and
        // context summary); the on-screen conversation is reset here. Repository
        // files, Git state, and memory files are untouched — only session state.
        // First-token match (like resolveSlashCommand): "/clear anything" still
        // clears — a fresh session takes no arguments.
        if (trimmed.split(/\s+/)[0] === "/clear") {
            const next = onResetSession();
            setSessionId(next.sessionId);
            setSessionNumber(next.sessionNumber);
            setMessages([]);
            setActivity([]);
            setLiveTool(null);
            setStreaming(null);
            setStatus("ready");
            setNotice("Session cleared. Starting a new conversation.");
            logger.info(`[UI] /clear — fresh session: ${next.sessionId} (#${next.sessionNumber})`);
            return;
        }

        logger.info(`[UI] User submitted: "${trimmed.slice(0, 100)}"`);
        push("user", trimmed);
        setLoading(true);
        setStatus("running");
        // A fresh run restarts the ^C^C exit window — Ctrl+C here is the first
        // press of the new run, not a double-press left over from a prior one.
        lastCancelTsRef.current = 0;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const confirmHook = buildConfirmHook();
            const response = await agentLoop.execute(sessionId, trimmed, {
                confirmHook,
                onEvent: handleAgentEvent,
                signal: controller.signal,
            });
            logger.info(`[UI] Agent response received (len=${response.length})`);
            push("assistant", response);
            setStreaming(null); // the live bubble becomes the stored message
            setStatus("ready");
        } catch (err) {
            setLiveTool(null); // an aborted run may have left a ghost tool row
            setStreaming(null); // discard any partially-streamed reply
            // Cancellation is NOT an error: the activity feed shows "⚠ Cancelled",
            // and the session stays usable for the next prompt.
            if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
                logger.info("[UI] Agent run cancelled");
                handleAgentEvent({ type: "cancelled" });
                setStatus("cancelled");
            } else {
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.error(`[UI] Agent execution failed: ${errMsg}`, {
                    stack: err instanceof Error ? err.stack : undefined,
                });
                push("error", errMsg);
                setStatus("error");
            }
        } finally {
            // A finished run can no longer be cancelled by a late keypress.
            abortRef.current = null;
            setLoading(false);
        }
    }, [loading, sessionId, agentLoop, buildConfirmHook, handleAgentEvent, onResetSession]);

    return (
        <box
            flexDirection="column"
            backgroundColor={C.bg}
            width="100%"
            height="100%"
        >
            {/* ── Header ──────────────────────────────────────────────── */}
            <box
                paddingX={2}
                paddingY={1}
                border={["bottom"]}
                borderColor={C.overlay0}
            >
                <Header />
            </box>

            {/* ── Messages area ───────────────────────────────────────── */}
            <scrollbox
                ref={scrollRef}
                flexGrow={1}
                stickyScroll={true}
                stickyStart="bottom"
                backgroundColor={C.bg}
                overflow="scroll"
            >
                {/* Top padding spacer */}
                <box height={1} />

                {messages.length === 0 && !loading && (
                    <box
                        flexDirection="column"
                        alignItems="center"
                        justifyContent="center"
                        paddingY={4}
                        gap={1}
                    >
                        <text fg={C.subtitle} attributes={TextAttributes.DIM}>
                            ✦  Welcome to NightCode  ✦
                        </text>
                        {notice ? (
                            <text fg={C.green} attributes={TextAttributes.BOLD}>
                                {notice}
                            </text>
                        ) : (
                            <text fg={C.overlay1} attributes={TextAttributes.DIM}>
                                Ask something to get started
                            </text>
                        )}
                    </box>
                )}

                {messages.map((msg) => (
                    <box key={msg.id} marginBottom={1}>
                        <MessageBubble msg={msg} />
                    </box>
                ))}

                {/* Live streaming reply — same slot the final message will land in */}
                {streaming && (
                    <box key={streaming.id} marginBottom={1}>
                        <MessageBubble msg={{ id: streaming.id, role: "assistant", content: streaming.text }} />
                    </box>
                )}

                {activity.length > 0 && (
                    <box paddingX={2} flexDirection="column" marginBottom={1}>
                        {activity.map((event, i) => {
                            if (event.type === "stage") return <StageRow key={i} name={event.name} />;
                            if (event.type === "iteration") return <IterationRow key={i} n={event.n} max={event.max} />;
                            if (event.type === "tool_end") return <ToolEndRow key={i} event={event} />;
                            if (event.type === "cancelled") {
                                return (
                                    <text fg={C.yellow} attributes={TextAttributes.BOLD}>
                                        ⚠ Cancelled
                                    </text>
                                );
                            }
                            return null;
                        })}
                        {liveTool && (
                            <box flexDirection="row" gap={1}>
                                <text fg={C.yellow} attributes={TextAttributes.DIM}>
                                    →
                                </text>
                                <text fg={C.yellow} attributes={TextAttributes.DIM} wrapMode="word">
                                    {liveTool.toolName} {liveTool.argsPreview} · {liveElapsed}s
                                </text>
                            </box>
                        )}
                    </box>
                )}

                {loading && !liveTool && !streaming && (
                    <box paddingX={2} marginBottom={1}>
                        <ThinkingIndicator />
                    </box>
                )}

                {/* Bottom padding spacer */}
                <box height={1} />
            </scrollbox>

            {/* ── Confirmation dialog (fixed above input bar) ───────── */}
            {pendingConfirm && (
                <ConfirmDialog pending={pendingConfirm} />
            )}

            {/* ── Input area ──────────────────────────────────────────── */}
            <box
                border={["top"]}
                borderColor={C.overlay0}
                backgroundColor={C.surface0}
            >
                <InputBar
                    onSubmit={handleSubmit}
                    disabled={loading || !!pendingConfirm}
                    commands={commands}
                    model={model}
                    cwd={CWD}
                    status={status}
                    sessionNumber={sessionNumber}
                    modelMenu={
                        getModelOptions && onSwitchModel
                            ? {
                                  getData: getModelOptions,
                                  providerId,
                                  onSelect: handleModelSelect,
                              }
                            : undefined
                    }
                />
            </box>
        </box>
    );
}
