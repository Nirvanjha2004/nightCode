import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { Header } from "./header";
import { InputBar } from "./input-bar";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import "../telemetry";
import type { AgentLoop } from "../agent/loop";
import type { AgentEvent, ConfirmHook } from "../agent/types";
import type { Command } from "./commands-menu/types";
import type { AgentStatus } from "./status-bar";
import type { ModelMenuData } from "./model-menu/types";
import { logger } from "../logger";
import { MarkdownContent } from "./markdown";
import { C, G, SPINNER, SPINNER_MS, SPINNER_START } from "./theme";

// Display-only — agent context lives in backend MessageManager, not here
type DisplayMessage = {
    id: string;
    role: "user" | "assistant" | "error";
    content: string;
};

/**
 * One entry in the transcript. Messages and agent events share a single ordered
 * list so a run reads as a story top-to-bottom — prompt, then the tools it took
 * to answer it, then the answer — instead of the tool log piling up in its own
 * region at the bottom of the screen, detached from the turn that produced it.
 */
type TimelineItem =
    | { kind: "msg"; id: string; msg: DisplayMessage }
    | { kind: "event"; id: string; event: AgentEvent; args?: string };

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

// ── Text helpers ───────────────────────────────────────────────────────────────

/** Flatten to one line and cap the length — for args shown beside a tool name. */
function oneLine(s: string, max: number): string {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Tool output shown under a call. Capped at a few lines with a "+N lines" tail so
 * a chatty tool (a diff, a directory listing) stays a glanceable summary instead
 * of burying the answer that follows it — the full result still reaches the model.
 */
const PREVIEW_LINES = 3;
const PREVIEW_LINE_CHARS = 200;

function preview(s: string): { lines: string[]; extra: number } {
    const all = (s ?? "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    const lines = all
        .slice(0, PREVIEW_LINES)
        .map((l) => (l.length > PREVIEW_LINE_CHARS ? `${l.slice(0, PREVIEW_LINE_CHARS - 1)}…` : l));
    return { lines, extra: Math.max(0, all.length - PREVIEW_LINES) };
}

// ── Layout primitive ───────────────────────────────────────────────────────────
// Every transcript row is a one-column gutter holding a mark, then the content.
// Sharing it is what makes prompts, tool calls, results and the spinner line up
// down a single spine instead of each drifting to its own indentation.
function Row({
    mark,
    markFg,
    nested = false,
    marginBottom = 0,
    children,
}: {
    mark: string;
    markFg: string;
    /** Shift one gutter to the right — used to hang a result under its call. */
    nested?: boolean;
    marginBottom?: number;
    children: ReactNode;
}) {
    return (
        <box
            flexDirection="row"
            gap={1}
            paddingX={1}
            marginBottom={marginBottom}
            alignItems="flex-start"
        >
            {nested && <box flexShrink={0} width={1} />}
            <box flexShrink={0} width={1}>
                <text fg={markFg} wrapMode="none">
                    {mark}
                </text>
            </box>
            <box flexGrow={1} flexDirection="column">
                {children}
            </box>
        </box>
    );
}

// ── Confirmation dialog ────────────────────────────────────────────────────────
type PendingConfirm = {
    resolve: (value: boolean) => void;
    message: string;
    toolName: string;
    args: Record<string, unknown>;
};

const CONFIRM_CHOICES: Array<[key: string, label: string, fg: string]> = [
    ["y", "run it", C.success],
    ["n", "skip it", C.danger],
    ["esc", "same as n", C.faint],
];

function ConfirmDialog({ pending }: { pending: PendingConfirm }) {
    const argsStr = JSON.stringify(pending.args).slice(0, 200);

    return (
        <box paddingX={1} paddingTop={1} flexDirection="column" flexShrink={0}>
            <box
                border={true}
                borderStyle="rounded"
                borderColor={C.peach}
                backgroundColor={C.panel}
                paddingX={1}
                flexDirection="column"
            >
                {/* Header */}
                <box flexDirection="row" gap={1} alignItems="center">
                    <text fg={C.peach} wrapMode="none">{G.warn}</text>
                    <text attributes={TextAttributes.BOLD} fg={C.peach} wrapMode="none" truncate>
                        Destructive action
                    </text>
                </box>

                {/* What is about to run. wrapMode="word" keeps a long args preview
                    readable (wrapped) on narrow terminals instead of clipping. */}
                <box paddingTop={1}>
                    <text fg={C.text} wrapMode="word">
                        {pending.toolName}({argsStr})
                    </text>
                </box>

                {/* Choices — the affirmative one first, each keyed by its letter.
                    The key column is fixed-width so the labels line up: `esc` is
                    three characters and `y` is one, and a ragged left edge here
                    reads as three unrelated notes rather than one menu. */}
                <box paddingTop={1} flexDirection="column">
                    {CONFIRM_CHOICES.map(([key, label, fg]) => (
                        <box key={key} flexDirection="row" gap={1}>
                            <box flexShrink={0} width={3}>
                                <text fg={fg} attributes={TextAttributes.BOLD} wrapMode="none">
                                    {key}
                                </text>
                            </box>
                            <text fg={C.muted} wrapMode="none" truncate>
                                {label}
                            </text>
                        </box>
                    ))}
                </box>
            </box>
        </box>
    );
}

// ── Progress indicator ─────────────────────────────────────────────────────────
// Verbs rotate slowly so a long run feels like it is getting somewhere; the
// elapsed counter is the honest signal underneath it, and the interrupt hint
// appears whenever there is room for it.
const VERBS = ["Thinking", "Reasoning", "Working", "Pondering", "Untangling", "Wrangling"];
const HINT_MIN_WIDTH = 52;

function ThinkingIndicator({ tick, elapsed }: { tick: number; elapsed: number }) {
    const { width } = useTerminalDimensions();
    const verb = VERBS[Math.floor(elapsed / 6) % VERBS.length]!;
    // "0s" is a number that has not said anything yet — the clock only earns a
    // place on the row once it has something to report.
    const hint = width >= HINT_MIN_WIDTH ? "esc to interrupt" : "";
    const meta = [elapsed > 0 ? `${elapsed}s` : "", hint].filter(Boolean).join(" · ");

    return (
        <Row mark={SPINNER[tick % SPINNER.length]!} markFg={C.accent2} marginBottom={1}>
            <text fg={C.muted} wrapMode="none" truncate>
                {verb}…{" "}
                <span fg={C.faint}>{meta ? `(${meta})` : ""}</span>
            </text>
        </Row>
    );
}

// ── Agent activity feed ────────────────────────────────────────────────────────
const STAGE_LABELS: Record<string, string> = {
    memory: "loading memory",
    extract: "saving memories",
};

// A second cancellation within this window exits the app (^C^C), mirroring the
// old Ctrl+C-exits-everything behavior without killing the process mid-run.
const CANCEL_TO_EXIT_MS = 2000;

/** A background step the loop took — deliberately quiet. */
function NoteRow({ label }: { label: string }) {
    return (
        <Row mark="·" markFg={C.faint}>
            <text fg={C.faint} attributes={TextAttributes.DIM} wrapMode="word">
                {label}
            </text>
        </Row>
    );
}

/** A finished tool call plus its result, drawn as a call → result branch. */
function ToolEndRow({ event, args }: { event: Extract<AgentEvent, { type: "tool_end" }>; args?: string }) {
    const { lines, extra } = preview(event.resultPreview);
    const hasResult = lines.length > 0;

    return (
        <box flexDirection="column" marginBottom={1}>
            <Row mark={G.dot} markFg={event.ok ? C.success : C.danger}>
                <text fg={C.text} wrapMode="word">
                    {event.toolName}
                    <span fg={C.muted}>{args ? `(${args})` : ""}</span>
                    <span fg={C.faint}>{"  "}{(event.durationMs / 1000).toFixed(1)}s</span>
                </text>
            </Row>
            {hasResult && (
                <Row mark={G.branch} markFg={C.faint} nested>
                    {lines.map((l, i) => (
                        <text key={i} fg={C.muted} attributes={TextAttributes.DIM} wrapMode="word">
                            {l}
                        </text>
                    ))}
                    {extra > 0 && (
                        <text fg={C.faint} attributes={TextAttributes.DIM} wrapMode="none">
                            … +{extra} lines
                        </text>
                    )}
                </Row>
            )}
        </box>
    );
}

/** The tool currently running — same shape as a finished one, with a live clock. */
function LiveToolRow({
    tool,
    elapsed,
    tick,
}: {
    tool: { toolName: string; argsPreview: string };
    elapsed: number;
    tick: number;
}) {
    return (
        <Row mark={SPINNER[tick % SPINNER.length]!} markFg={C.warn} marginBottom={1}>
            <text fg={C.text} wrapMode="word">
                {tool.toolName}
                <span fg={C.muted}>{tool.argsPreview ? `(${oneLine(tool.argsPreview, 64)})` : ""}</span>
                <span fg={C.faint}>{elapsed > 0 ? `  ${elapsed}s` : ""}</span>
            </text>
        </Row>
    );
}

function TimelineRow({ item }: { item: TimelineItem }) {
    if (item.kind === "msg") return <MessageBubble msg={item.msg} />;

    const { event } = item;
    if (event.type === "stage") return <NoteRow label={STAGE_LABELS[event.name] ?? event.name} />;
    if (event.type === "iteration") return <NoteRow label={`step ${event.n} of ${event.max}`} />;
    if (event.type === "tool_end") return <ToolEndRow event={event} args={item.args} />;
    if (event.type === "cancelled") {
        return (
            <Row mark={G.warn} markFg={C.warn} marginBottom={1}>
                <text fg={C.warn} attributes={TextAttributes.BOLD} wrapMode="word">
                    Cancelled
                </text>
            </Row>
        );
    }
    return null;
}

// ── Message ────────────────────────────────────────────────────────────────────
// Flat rows, no bubbles: a chat frame around every turn spends four columns and
// two rows of chrome per message to encode one bit — who is speaking — that a
// single colored mark already carries. Dropping it leaves the terminal's real
// content (code, diffs, tool output) the full width it wants.
const ROLE_CONFIG: Record<DisplayMessage["role"], { mark: string; markFg: string; textFg: string }> = {
    user:      { mark: G.quote, markFg: C.faint,   textFg: C.muted },
    assistant: { mark: G.dot,   markFg: C.accent2, textFg: C.text },
    error:     { mark: G.fail,  markFg: C.danger,  textFg: C.danger },
};

export function MessageBubble({ msg }: { msg: DisplayMessage }) {
    const cfg = ROLE_CONFIG[msg.role];

    return (
        <Row mark={cfg.mark} markFg={cfg.markFg} marginBottom={1}>
            {msg.role === "assistant" ? (
                <MarkdownContent content={msg.content} />
            ) : (
                <text fg={cfg.textFg} wrapMode="word">
                    {msg.content}
                </text>
            )}
        </Row>
    );
}

// ── Welcome ────────────────────────────────────────────────────────────────────
// Seen once per session and then scrolled away, so it can afford the full
// wordmark — but only where it fits. Below the art threshold it degrades to a
// one-line brand rather than a clipped ASCII smear.
const ART_MIN_WIDTH = 62;
const TIPS_MIN_WIDTH = 64;

const TIPS: Array<[string, string]> = [
    ["/", "commands"],
    ["^m", "switch model"],
    ["esc", "interrupt"],
    ["^c^c", "exit"],
];

function Welcome({ notice }: { notice: string | null }) {
    const { width } = useTerminalDimensions();

    return (
        <box flexDirection="column" alignItems="center" paddingX={1} paddingY={2} gap={1}>
            {width >= ART_MIN_WIDTH ? (
                <box flexDirection="row" gap={0.5} alignItems="center">
                    <ascii-font font="tiny" text="Night" color={C.accent} />
                    <ascii-font font="tiny" text="Code" color={C.accent2} />
                </box>
            ) : (
                <text attributes={TextAttributes.BOLD} fg={C.accent} wrapMode="none">
                    {G.spark} NightCode {G.spark}
                </text>
            )}

            <text fg={C.muted} attributes={TextAttributes.DIM} wrapMode="none" truncate>
                your terminal-native coding agent
            </text>

            {notice ? (
                <text fg={C.success} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                    {notice}
                </text>
            ) : (
                <text fg={C.faint} attributes={TextAttributes.DIM} wrapMode="none" truncate>
                    ask anything to get started
                </text>
            )}

            {width >= TIPS_MIN_WIDTH && (
                <box flexDirection="row" gap={2} alignItems="center">
                    {TIPS.map(([key, label]) => (
                        <box key={key} flexDirection="row" gap={1} alignItems="center">
                            <text fg={C.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                                {key}
                            </text>
                            <text fg={C.faint} attributes={TextAttributes.DIM} wrapMode="none">
                                {label}
                            </text>
                        </box>
                    ))}
                </box>
            )}
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
    const [timeline, setTimeline] = useState<TimelineItem[]>([]);
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

    // Stable across renders — handleAgentEvent captures it once.
    const pushItem = useCallback(
        (item: TimelineItem) => setTimeline((prev) => [...prev, item]),
        []
    );

    const push = useCallback(
        (role: DisplayMessage["role"], content: string) => {
            const id = crypto.randomUUID();
            pushItem({ kind: "msg", id, msg: { id, role, content } });
        },
        [pushItem]
    );

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
    const [liveTool, setLiveTool] = useState<{ toolName: string; argsPreview: string; startedAt: number } | null>(null);
    const [liveElapsed, setLiveElapsed] = useState(0);
    // Live assistant reply — appended as text_delta events arrive (Pi-style
    // streaming). Rendered in the same slot the final message lands in, then
    // replaced by it when the run resolves.
    const [streaming, setStreaming] = useState<{ id: string; text: string } | null>(null);
    // Live reasoning/thinking text — appended as reasoning_delta events arrive,
    // shown in a dimmed panel while the model works, discarded on completion.
    const [reasoning, setReasoning] = useState("");
    // Animation clock and run clock. Both only run while a turn is in flight, so
    // an idle NightCode repaints nothing at all.
    const [tick, setTick] = useState(SPINNER_START);
    const [runElapsed, setRunElapsed] = useState(0);
    // tool_end carries no arguments, so the preview from its tool_start is held
    // here and reattached when the call finishes — a tool call reads as
    // `name(args)` in the transcript the same way you would write it.
    const toolArgsRef = useRef<Record<string, string>>({});

    useEffect(() => {
        if (!loading) return;
        const t = setInterval(() => setTick((v) => v + 1), SPINNER_MS);
        return () => clearInterval(t);
    }, [loading]);

    useEffect(() => {
        if (!loading) {
            setRunElapsed(0);
            return;
        }
        const startedAt = Date.now();
        const t = setInterval(() => setRunElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => clearInterval(t);
    }, [loading]);

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
            toolArgsRef.current[event.toolName] = event.argsPreview;
            setLiveTool({ toolName: event.toolName, argsPreview: event.argsPreview, startedAt: Date.now() });
            setLiveElapsed(0);
            return;
        }
        if (event.type === "tool_end") {
            const args = toolArgsRef.current[event.toolName];
            delete toolArgsRef.current[event.toolName];
            setLiveTool(null);
            pushItem({
                kind: "event",
                id: crypto.randomUUID(),
                event,
                args: args ? oneLine(args, 64) : undefined,
            });
            return;
        }
        if (event.type === "cancelled") {
            // A cancelled run may have left a ghost live-tool row — clear it.
            setLiveTool(null);
            pushItem({ kind: "event", id: crypto.randomUUID(), event });
            return;
        }
        if (event.type === "reasoning_delta") {
            // Append to the thinking panel; cap it so a huge extended-thinking
            // block can't grow the render tree without bound.
            setReasoning((prev) => {
                if (prev.endsWith("… (reasoning truncated)")) return prev;
                const next = prev + event.text;
                return next.length > 12000
                    ? next.slice(0, 12000) + "\n… (reasoning truncated)"
                    : next;
            });
            return;
        }
        if (event.type === "text_delta") {
            // Append to the live assistant bubble (create it on first delta).
            setStreaming((prev) => ({
                id: prev?.id ?? crypto.randomUUID(),
                text: (prev?.text ?? "") + event.text,
            }));
            setReasoning(""); // the answer is starting — collapse the thinking panel
            return;
        }
        if (event.type === "iteration") {
            // A new ReAct iteration means a fresh model call — its thinking
            // replaces the previous block instead of concatenating onto it.
            pushItem({ kind: "event", id: crypto.randomUUID(), event });
            setReasoning("");
            return;
        }
        pushItem({ kind: "event", id: crypto.randomUUID(), event });
    }, [pushItem]);

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
            setTimeline([]);
            setLiveTool(null);
            setStreaming(null);
            setReasoning("");
            toolArgsRef.current = {};
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
            setReasoning(""); // the thinking panel is display-only
            setStatus("ready");
        } catch (err) {
            setLiveTool(null); // an aborted run may have left a ghost tool row
            setStreaming(null); // discard any partially-streamed reply
            setReasoning(""); // …and any partial thinking
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
    }, [loading, sessionId, agentLoop, buildConfirmHook, handleAgentEvent, onResetSession, push]);

    return (
        <box
            flexDirection="column"
            backgroundColor={C.bg}
            width="100%"
            height="100%"
        >
            {/* ── Header — one row of brand, one of rule ───────────────
                Explicit height: the bottom border needs a row of its own, and
                flexShrink={0} keeps the chrome intact on a short terminal —
                the transcript is what should give up space, never the frame. */}
            <box height={2} flexShrink={0} paddingX={1} border={["bottom"]} borderColor={C.line}>
                <Header />
            </box>

            {/* ── Transcript ──────────────────────────────────────────── */}
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

                {timeline.length === 0 && !loading && <Welcome notice={notice} />}

                {timeline.map((item) => (
                    <TimelineRow key={item.id} item={item} />
                ))}

                {/* Live streaming reply — same slot the final message will land in */}
                {streaming && (
                    <MessageBubble
                        key={streaming.id}
                        msg={{ id: streaming.id, role: "assistant", content: streaming.text }}
                    />
                )}

                {liveTool && <LiveToolRow tool={liveTool} elapsed={liveElapsed} tick={tick} />}

                {/* Live reasoning panel — the model's thoughts as they happen. Held
                    behind a rail so it reads as an aside to the answer, not as the
                    answer itself. */}
                {reasoning && loading && (
                    <box flexDirection="column" marginBottom={1}>
                        <Row mark={SPINNER[tick % SPINNER.length]!} markFg={C.accent2}>
                            <text fg={C.accent2} attributes={TextAttributes.DIM} wrapMode="none">
                                thinking
                            </text>
                        </Row>
                        <box flexDirection="row" gap={1} paddingX={1} alignItems="flex-start">
                            <box flexShrink={0} width={1} />
                            <box
                                flexGrow={1}
                                border={["left"]}
                                borderColor={C.line}
                                paddingX={1}
                                flexDirection="column"
                            >
                                <text fg={C.faint} attributes={TextAttributes.DIM} wrapMode="word">
                                    {reasoning}
                                </text>
                            </box>
                        </box>
                    </box>
                )}

                {loading && !liveTool && !streaming && !reasoning && (
                    <ThinkingIndicator tick={tick} elapsed={runElapsed} />
                )}

                {/* Bottom padding spacer */}
                <box height={1} />
            </scrollbox>

            {/* ── Confirmation dialog (fixed above the composer) ───────── */}
            {pendingConfirm && <ConfirmDialog pending={pendingConfirm} />}

            {/* ── Composer ────────────────────────────────────────────── */}
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
    );
}
