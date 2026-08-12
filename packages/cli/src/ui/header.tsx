import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";

const C = {
    blue:     "#89B4FA",
    mauve:    "#CBA6F7",
    text:     "#CDD6F4",
    surface2: "#222233",
};

// The tiny-font "NightCode" brand is ~34 columns wide, and inside the App's
// padded header the version meta stays clear of the ASCII art only down to ~76
// columns (below that the framework squeezes the two side by side and the
// meta overlaps the glyphs). Below the threshold the meta is hidden and the
// art clips cleanly instead of overlapping.
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
            {/* Left: Branding */}
            <box
                flexDirection="row"
                gap={0.5}
                alignItems="center"
            >
                <ascii-font
                    font="tiny"
                    text="Night"
                    color={C.blue}
                />
                <ascii-font
                    font="tiny"
                    text="Code"
                    color={C.mauve}
                />
            </box>

            {/* Right: Meta info — hidden on narrow terminals so it never overlaps the brand */}
            {showMeta && (
                <box
                    flexDirection="row"
                    gap={2}
                    alignItems="center"
                >
                    <text attributes={TextAttributes.DIM} fg={C.surface2}>
                        |
                    </text>

                    <text fg={C.text} attributes={TextAttributes.DIM}>
                        v1.0.0
                    </text>
                </box>
            )}
        </box>
    );
}