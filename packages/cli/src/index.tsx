import { useState, useCallback, useRef, useEffect } from "react";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import "./telemetry";
import type { AgentLoop } from "../src/agent/loop";
import type { ConfirmHook } from "./agent/types";
import { logger } from "./logger";
// Display-only — agent context lives in backend MessageManager, not here
type DisplayMessage = {
    id: string;
    role: "user" | "assistant" | "error";
    content: string;
};

type Props = {
    sessionId: string;
    agentLoop: AgentLoop;
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

                {/* Tool info — use a single text element with interpolated string */}
                <box paddingX={1}>
                    <text fg={C.text}>
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

// ── Message bubble component ───────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: DisplayMessage }) {
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

                {/* Message content */}
                <box paddingX={1} paddingY={1}>
                    <text
                        fg={C.text}
                        wrapMode="word"
                    >
                        {msg.content}
                    </text>
                </box>
            </box>
        </box>
    );
}

// ── Main App ───────────────────────────────────────────────────────────────────
export function App({ sessionId, agentLoop }: Props) {
    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
    const pendingRef = useRef(pendingConfirm);
    pendingRef.current = pendingConfirm;
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);

    const push = (role: DisplayMessage["role"], content: string) => {
        setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role, content },
        ]);
    };

    // ── Keyboard handler: intercept Y/N/Esc when confirmation is pending ──
    // Use ref to avoid stale closures (useKeyboard may capture the handler once)
    useKeyboard((keyEvent) => {
        const p = pendingRef.current;
        if (!p) return;

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
    });

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

        logger.info(`[UI] User submitted: "${trimmed.slice(0, 100)}"`);
        push("user", trimmed);
        setLoading(true);
        try {
            const confirmHook = buildConfirmHook();
            const response = await agentLoop.execute(sessionId, trimmed, confirmHook);
            logger.info(`[UI] Agent response received (len=${response.length})`);
            push("assistant", response);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[UI] Agent execution failed: ${errMsg}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
            push("error", errMsg);
        } finally {
            setLoading(false);
        }
    }, [loading, sessionId, agentLoop, buildConfirmHook]);

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
                        <text fg={C.overlay1} attributes={TextAttributes.DIM}>
                            Ask something to get started
                        </text>
                    </box>
                )}

                {messages.map((msg) => (
                    <box key={msg.id} marginBottom={1}>
                        <MessageBubble msg={msg} />
                    </box>
                ))}

                {loading && (
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
                <InputBar onSubmit={handleSubmit} disabled={loading || !!pendingConfirm} />
            </box>
        </box>
    );
}
