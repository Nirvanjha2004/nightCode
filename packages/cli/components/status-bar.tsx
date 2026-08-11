import { TextAttributes } from "@opentui/core";
import { homedir } from "node:os";

const C = {
    blue:     "#89B4FA",
    subtitle: "#6B6B7B",
    green:    "#A6E3A1",
    yellow:   "#F9E2AF",
    peach:    "#FAB387",
    red:      "#F38BA8",
};

/** Lifecycle of the agent loop as seen from the UI. */
export type AgentStatus = "ready" | "running" | "cancelled" | "error";

const STATUS_COLOR: Record<AgentStatus, string> = {
    ready:     C.green,
    running:   C.yellow,
    cancelled: C.peach,
    error:     C.red,
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

export function StatusBar({ model, cwd, status }: StatusBarProps) {
    return (
        <box
            flexDirection="row"
            gap={1}
            alignItems="center"
            width="100%"
        >
            {/* Model · Working Directory · Current State.
                wrapMode="none" keeps the bar on ONE row on narrow terminals; the
                model and path absorb the shrink (truncate adds the …), while the
                separators and status label never shrink so the state stays readable. */}
            <text attributes={TextAttributes.BOLD} fg={C.blue} wrapMode="none" truncate>
                {model}
            </text>

            <text attributes={TextAttributes.DIM} fg={C.subtitle} wrapMode="none" flexShrink={0}>
                ·
            </text>

            <text attributes={TextAttributes.DIM} fg={C.subtitle} wrapMode="none" truncate>
                {compactPath(cwd, 40)}
            </text>

            <text attributes={TextAttributes.DIM} fg={C.subtitle} wrapMode="none" flexShrink={0}>
                ·
            </text>

            <text attributes={TextAttributes.BOLD} fg={STATUS_COLOR[status]} wrapMode="none" flexShrink={0}>
                {STATUS_LABEL[status]}
            </text>
        </box>
    );
}