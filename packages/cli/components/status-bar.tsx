import { TextAttributes } from "@opentui/core";

const C = {
    green:    "#A6E3A1",
    subtitle: "#6B6B7B",
    blue:     "#89B4FA",
    text:     "#CDD6F4",
    peach:    "#FAB387",
};

type StatusBarProps = {
    model?: string;
    chars?: number;
};

export function StatusBar({ model = "groq", chars = 0 }: StatusBarProps) {
    return (
        <box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            width="100%"
        >
            {/* Left: context info */}
            <box flexDirection="row" gap={2}>
                <text fg={C.blue} attributes={TextAttributes.BOLD}>
                    Build
                </text>

                <text attributes={TextAttributes.DIM} fg={C.subtitle}>
                    {chars} chars
                </text>
            </box>

            {/* Right: model name */}
            <box flexDirection="row" gap={1} alignItems="center">
                <text attributes={TextAttributes.DIM} fg={C.subtitle}>
                    model:
                </text>
                <box
                    border={true}
                    borderStyle="rounded"
                    borderColor={C.green}
                    paddingX={1}
                >
                    <text fg={C.green} attributes={TextAttributes.DIM}>
                        {model}
                    </text>
                </box>
            </box>
        </box>
    );
}