import { useRef, useCallback } from "react";
import type { TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { StatusBar, type AgentStatus } from "./status-bar";
import { CommandMenu } from "./commands-menu";
import { useCommandMenu } from "./commands-menu/use-command-menu";
import type { Command } from "./commands-menu/types";
import { ModelMenu } from "./model-menu";
import { useModelMenu } from "./model-menu/use-model-menu";
import type { ModelMenuData } from "./model-menu/types";
import { logger } from "../logger";
import { C, G } from "./theme";

export type ModelMenuProps = {
    /** Build the provider/model list (fresh on each menu open). */
    getData: () => ModelMenuData;
    /** Active provider id (for the ✓ marker). */
    providerId?: string;
    /** Called when the user picks a model — switches provider + model. */
    onSelect: (providerId: string, modelId: string) => void;
};

type Props = {
    onSubmit: (text: string) => void;
    disabled?: boolean;
    model: string;
    cwd: string;
    status: AgentStatus;
    /** Human-friendly session counter shown in the status bar. */
    sessionNumber: number;
    /** Commands to suggest in the menu (slash commands from the backend registry). */
    commands: Command[];
    /** When present, Ctrl+M opens the model selector. */
    modelMenu?: ModelMenuProps;
};

export function InputBar({ onSubmit, disabled = false, model, cwd, status, sessionNumber, commands, modelMenu }: Props) {
    const textareaRef = useRef<TextareaRenderable>(null);
    const scrollRef   = useRef<ScrollBoxRenderable | null>(null);
    const cmd         = useCommandMenu(commands);
    const cmdRef = useRef(cmd);
    cmdRef.current = cmd;

    const activeKey = modelMenu ? `${modelMenu.providerId ?? "?"}/${model}` : model;
    const menu      = useModelMenu(modelMenu?.getData ?? (() => ({ providers: [] })), activeKey);
    const menuRef = useRef(menu);
    menuRef.current = menu;
    // Saved textarea draft while the model menu is open — restored on close.
    const draftRef = useRef("");

    const openModelMenu = useCallback(() => {
        if (!modelMenu) return;
        if (cmdRef.current.isOpen) cmdRef.current.close();
        draftRef.current = textareaRef.current?.plainText ?? "";
        textareaRef.current?.setText("");
        menuRef.current.open("");
        logger.info("[UI] Model menu opened");
    }, [modelMenu]);

    const closeModelMenu = useCallback(() => {
        menuRef.current.close();
        const draft = draftRef.current;
        draftRef.current = "";
        if (draft) textareaRef.current?.setText(draft);
    }, []);

    const handleContentChange = useCallback(() => {
        const text = textareaRef.current?.plainText ?? "";
        const m    = menuRef.current;
        if (m.isOpen) {
            m.setQueryText(text);
            return;
        }
        const c = cmdRef.current;
        if (text.startsWith("/") && !text.includes(" ")) {
            c.open(text);
        } else if (c.isOpen) {
            c.close();
        }
    }, []);

    useKeyboard((keyEvent) => {
        const c       = cmdRef.current;
        const m       = menuRef.current;
        const isEnter = keyEvent.name === "return" || keyEvent.name === "enter";

        // ── Model menu intercepts ────────────────────────────────────
        if (m.isOpen) {
            if (keyEvent.name === "escape") {
                closeModelMenu();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }
            if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "p")) {
                m.navigateUp();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }
            if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "n")) {
                m.navigateDown();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }
            if (keyEvent.name === "tab") {
                m.cycleProvider(m.providerIds);
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }
            if (keyEvent.ctrl && keyEvent.name === "f") {
                const row = m.filtered[m.selectedIndex];
                if (row) m.toggleFav(row.key);
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }
            if (isEnter) {
                const row = m.filtered[m.selectedIndex];
                if (row) {
                    m.recordSelection(row.key);
                    modelMenu?.onSelect(row.providerId, row.modelId);
                    logger.info(`[UI] Model selected: ${row.key}`);
                }
                closeModelMenu();
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }
            return;
        }

        // ── Ctrl+M toggles the model selector (idle or running) ─────
        if (keyEvent.ctrl && keyEvent.name === "m") {
            if (m.isOpen) {
                closeModelMenu();
            } else {
                openModelMenu();
            }
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            return;
        }

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
                if (command) {
                    // Insert the chosen command (with a trailing space, ready for
                    // arguments) instead of submitting — slash commands take args.
                    textareaRef.current?.setText(`${command.value} `);
                    c.close();
                }
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                return;
            }

            return;
        }

        // ── Shift + Enter → newline ──────────────────────────────
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
        // flexShrink={0}: on a short terminal the transcript scrolls, but the
        // composer and its footer must never be clipped — they are how you drive
        // the app and how you read its state.
        <box flexDirection="column" flexShrink={0}>
            {/* Model selector dropdown */}
            {menu.isOpen && modelMenu && (
                <ModelMenu
                    menu={menu}
                    activeKey={activeKey}
                    onSelect={modelMenu.onSelect}
                />
            )}

            {/* Command menu dropdown */}
            {cmd.isOpen && (
                <box paddingX={1} flexDirection="column">
                    <box
                        border={true}
                        borderStyle="rounded"
                        borderColor={C.line}
                        backgroundColor={C.panel}
                        paddingX={1}
                        flexDirection="column"
                    >
                        <box paddingX={1} flexDirection="row" gap={1}>
                            <text attributes={TextAttributes.BOLD} fg={C.accent} wrapMode="none">
                                Commands
                            </text>
                            <text attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none" truncate>
                                · type to filter · ↑↓ move · ⏎ insert
                            </text>
                        </box>

                        <CommandMenu
                            query={cmd.query}
                            commands={commands}
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
                                    marginTop={1}
                                    border={["top"]}
                                    borderColor={C.line}
                                >
                                    <text attributes={TextAttributes.DIM} fg={C.muted} wrapMode="word">
                                        {command.description}
                                    </text>
                                </box>
                            ) : null;
                        })()}
                    </box>
                </box>
            )}

            {/* ── Composer ─────────────────────────────────────────────
                A rounded box IS the boundary between transcript and input —
                no separate divider rule above it. The border carries the focus
                state: accent while the agent is idle and waiting on you, faint
                while a run owns the turn. */}
            <box paddingX={1} paddingTop={1} flexDirection="column">
                <box
                    border={true}
                    borderStyle="rounded"
                    borderColor={disabled ? C.line : C.accent}
                    backgroundColor={C.panel}
                    paddingX={1}
                    flexDirection="row"
                    gap={1}
                    alignItems="flex-start"
                >
                    <text
                        attributes={TextAttributes.BOLD}
                        fg={disabled ? C.faint : C.accent}
                        wrapMode="none"
                        flexShrink={0}
                    >
                        {G.caret}
                    </text>
                    <box flexGrow={1} flexDirection="column">
                        <textarea
                            ref={textareaRef}
                            focused={!disabled}
                            onContentChange={handleContentChange}
                            // Short on purpose: a placeholder long enough to wrap
                            // steals transcript rows on a narrow terminal. The
                            // shortcuts live in the welcome screen and the `/` menu.
                            placeholder={disabled ? "working…" : "Ask anything…"}
                        />
                    </box>
                </box>

                {/* Footer: the quiet line. Everything here is reference, not action. */}
                <box paddingX={1}>
                    <StatusBar model={model} cwd={cwd} status={status} sessionNumber={sessionNumber} />
                </box>
            </box>
        </box>
    );
}
