import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { homedir } from "node:os";
import { C, G } from "./theme";

// Fields drop out entirely as the terminal narrows, rather than all of them
// shrinking together into a row of "g…b · …e ·" stubs. A field is either
// readable or absent; a truncated one is just noise wearing a label's clothes.
const MIN_WIDTH_MODEL = 34;
const MIN_WIDTH_SESSION = 46;
const MIN_WIDTH_CWD = 62;

/** Lifecycle of the agent loop as seen from the UI. */
export type AgentStatus = "ready" | "running" | "cancelled" | "error";

const STATUS_COLOR: Record<AgentStatus, string> = {
    ready:     C.success,
    running:   C.warn,
    cancelled: C.peach,
    error:     C.danger,
};

const STATUS_LABEL: Record<AgentStatus, string> = {
    ready:     "Ready",
    running:   "Running",
    cancelled: "Cancelled",
    error:     "Error",
};

type StatusBarProps = {
    model: string;
    cwd: string;
    status: AgentStatus;
    /** Human-friendly session counter (1, 2, …) — the "one current session" indicator. */
    sessionNumber: number;
};

// Compact path for small terminals: `~/…` for the home dir, then the last two
// segments with an ellipsis prefix if the path is still too long to fit.
function compactPath(p: string, maxLen: number): string {
    const home = homedir().replace(/\\/g, "/");
    const norm = p.replace(/\\/g, "/");
    const withTilde = norm.startsWith(home) ? `~${norm.slice(home.length)}` : norm;
    if (withTilde.length <= maxLen) return withTilde;
    const tail = withTilde.split("/").filter(Boolean).slice(-2).join("/");
    return tail.length < withTilde.length ? `…/${tail}` : withTilde;
}

/** A `·` spacer that never shrinks, so the fields either side stay legible. */
function Sep() {
    return (
        <text attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none" flexShrink={0}>
            ·
        </text>
    );
}

export function StatusBar({ model, cwd, status, sessionNumber }: StatusBarProps) {
    const { width } = useTerminalDimensions();

    return (
        <box flexDirection="row" gap={1} alignItems="center" width="100%">
            {/* State leads the row: it is the one field worth reading at any width,
                so it goes first and never shrinks. wrapMode="none" throughout keeps
                the whole bar on ONE row — the model and path absorb any overflow. */}
            <text fg={STATUS_COLOR[status]} wrapMode="none" flexShrink={0}>
                {G.pip}
            </text>
            <text attributes={TextAttributes.BOLD} fg={STATUS_COLOR[status]} wrapMode="none" flexShrink={0}>
                {STATUS_LABEL[status]}
            </text>

            {width >= MIN_WIDTH_MODEL && (
                <>
                    <Sep />
                    <text fg={C.muted} wrapMode="none" truncate>
                        {model}
                    </text>
                </>
            )}

            {width >= MIN_WIDTH_CWD && (
                <>
                    <Sep />
                    <text attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none" truncate>
                        {compactPath(cwd, 40)}
                    </text>
                </>
            )}

            {width >= MIN_WIDTH_SESSION && (
                <>
                    <Sep />
                    {/* Never shrinks: "sessi…" would be worse than useless — the
                        number is the entire point of the field. */}
                    <text attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none" flexShrink={0}>
                        session {sessionNumber}
                    </text>
                </>
            )}
        </box>
    );
}
