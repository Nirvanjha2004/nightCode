import { TextAttributes } from "@opentui/core";

const C = {
    blue:     "#89B4FA",
    mauve:    "#CBA6F7",
    text:     "#CDD6F4",
    subtitle: "#6B6B7B",
    surface2: "#222233",
};

export function Header() {
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

            {/* Right: Meta info */}
            <box
                flexDirection="row"
                gap={2}
                alignItems="center"
            >
                {/* Status dot */}
                <box flexDirection="row" gap={1} alignItems="center">
                    <text fg={C.blue}>●</text>
                    <text fg={C.subtitle} attributes={TextAttributes.DIM}>
                        connected
                    </text>
                </box>

                <text attributes={TextAttributes.DIM} fg={C.surface2}>
                    |
                </text>

                <text fg={C.text} attributes={TextAttributes.DIM}>
                    v1.0.0
                </text>
            </box>
        </box>
    );
}