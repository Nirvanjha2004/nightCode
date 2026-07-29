import { useRef, useCallback } from "react";
import type { TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { StatusBar } from "./status-bar";
import { CommandMenu } from "./commands-menu";
import { useCommandMenu } from "./commands-menu/use-command-menu";
import { logger } from "../src/logger";

type Props = {
    onSubmit: (text: string) => void;
    disabled?: boolean;
    model?: string;
};

export function InputBar({ onSubmit, disabled = false, model }: Props) {
    const textareaRef = useRef<TextareaRenderable>(null);
    const scrollRef   = useRef<ScrollBoxRenderable | null>(null);
    const cmd         = useCommandMenu();

    const cmdRef = useRef(cmd);
    cmdRef.current = cmd;

    const handleContentChange = useCallback(() => {
        const c    = cmdRef.current;
        const text = textareaRef.current?.plainText ?? "";

        if (text.startsWith("/")) {
            c.open(text);
        } else if (c.isOpen) {
            c.close();
        } else {
            c.updateQuery(text);
        }
    }, []);

    useKeyboard((keyEvent) => {
        const c       = cmdRef.current;
        const isEnter = keyEvent.name === "return" || keyEvent.name === "enter";

        // ── Command menu intercepts ──────────────────────────────
        if (c.isOpen) {
            if (keyEvent.name === "escape") {
                c.close();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "p")) {
                c.navigateUp();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "n")) {
                c.navigateDown();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            if (isEnter) {
                const command = c.filtered[c.selectedIndex];
                if (command) c.selectAt(c.selectedIndex);
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            return;
        }

        // ── Shift + Enter → newline ──────────────────────────────
        // textarea.newLine() is the correct API, not insertText("\n")
        if (isEnter && keyEvent.shift) {
            textareaRef.current?.newLine();
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            return;
        }

        // ── Enter → submit ───────────────────────────────────────
        if (isEnter && !keyEvent.shift) {
            if (disabled) {
                keyEvent.preventDefault();
                return;
            }

            const text    = textareaRef.current?.plainText ?? "";
            const trimmed = text.trim();

            if (!trimmed) {
                keyEvent.preventDefault();
                return;
            }

            // textarea.setText("") is the correct clear API, not clear()
            textareaRef.current?.setText("");
            c.close();
            logger.info(`[InputBar] Submit: "${trimmed.slice(0, 120)}"`);
            onSubmit(trimmed);

            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            return;
        }
    });

    return (
        <box flexDirection="column" gap={2}>
            {/* Command menu dropdown */}
            {cmd.isOpen && (
                <box
                    border={true}
                    borderStyle="rounded"
                    borderColor="#89B4FA"
                    backgroundColor="#13131A"
                    padding={1}
                    flexDirection="column"
                >
                    <box paddingX={1} paddingBottom={1}>
                        <text attributes={TextAttributes.BOLD} fg="#89B4FA">
                            Commands
                        </text>
                        <text attributes={TextAttributes.DIM} fg="#6B6B7B">
                            {" "}· type to filter
                        </text>
                    </box>

                    <CommandMenu
                        query={cmd.query}
                        selectedIndex={cmd.selectedIndex}
                        scrollRef={scrollRef}
                        onSelect={(index) => cmd.selectAt(index)}
                        onExecute={(index) => cmd.selectAt(index)}
                    />

                    {(() => {
                        const command = cmd.filtered[cmd.selectedIndex];
                        return command ? (
                            <box
                                paddingX={1}
                                paddingTop={1}
                                marginTop={1}
                                border={["top"]}
                                borderColor="#2A2A3A"
                            >
                                <text attributes={TextAttributes.DIM}>
                                    {command.description}
                                </text>
                            </box>
                        ) : null;
                    })()}
                </box>
            )}

            {/* Input area */}
            <box
                paddingX={2}
                paddingY={1}
                backgroundColor={disabled ? "#13131A" : "#1A1A24"}
                gap={1}
                flexDirection="column"
            >
                <textarea
                    ref={textareaRef}
                    focused={!disabled}
                    onContentChange={handleContentChange}
                    placeholder={
                        disabled
                            ? "Agent is thinking..."
                            : `Ask anything... "Fix a bug in the database"`
                    }
                />

                <StatusBar />
            </box>
        </box>
    );
}