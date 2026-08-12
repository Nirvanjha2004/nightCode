import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { C, G } from "./theme";

// The header is permanent chrome, so it costs a row of transcript on every
// screen — it stays a single line. The full ASCII wordmark lives in the welcome
// screen instead, where it is seen once and then scrolls away.
//
// Version meta is secondary: it only appears once the terminal is roomy enough
// (≥76 columns) that it reads as a quiet right-hand annotation. Below that the
// row belongs entirely to the brand.
const MIN_META_WIDTH = 76;

export function Header() {
    const { width } = useTerminalDimensions();
    const showMeta = width >= MIN_META_WIDTH;

    return (
        <box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            width="100%"
        >
            {/* Left: brand */}
            <box flexDirection="row" gap={1} alignItems="center">
                <text fg={C.accent2}>{G.mark}</text>
                <text attributes={TextAttributes.BOLD} fg={C.accent} wrapMode="none">
                    Night<span fg={C.accent2}>Code</span>
                </text>
            </box>

            {/* Right: version meta — hidden on narrow terminals */}
            {showMeta && (
                <box flexDirection="row" gap={1} alignItems="center">
                    <text attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none">
                        v1.0.0
                    </text>
                </box>
            )}
        </box>
    );
}
