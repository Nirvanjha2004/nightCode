import { useRef, useCallback } from "react";
import type { KeyBinding, ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { StatusBar } from "./status-bar";
import { CommandMenu } from "./commands-menu";
import { useCommandMenu } from "./commands-menu/use-command-menu";

type Props = {
  onSubmit: (text: string) => void;
  disabled?: boolean;
};

export const TEXTAREA_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

export function InputBar({ onSubmit, disabled = false }: Props) {
  const textareaRef = useRef<any>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const cmd = useCommandMenu();

  // Keep a stable ref to latest cmd state for the keyboard handler
  const cmdRef = useRef(cmd);
  cmdRef.current = cmd;

  // Sync textarea content on every change — uses ref to avoid stale closures
  const handleContentChange = useCallback(() => {
    const c = cmdRef.current;
    const text = textareaRef.current?.plainText ?? "";
    if (text.startsWith("/")) {
      c.open(text);
    } else if (c.isOpen) {
      c.close();
    } else {
      c.updateQuery(text);
    }
  }, []);

  // Global keyboard handler — fires before the textarea, so we can
  // intercept arrow/enter/escape when the command menu is open
  useKeyboard((keyEvent) => {
    const c = cmdRef.current;
    if (!c.isOpen) return;

    if (keyEvent.name === "escape") {
      c.close();
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      return;
    }

    if (c.filtered.length === 0) return;

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

    if (keyEvent.name === "return" || keyEvent.name === "enter") {
      const command = c.filtered[c.selectedIndex];
      if (command) {
        c.selectAt(c.selectedIndex);
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      return;
    }
  });

  return (
    <box flexDirection="column" gap={2}>
      {/* command menu dropdown — floating panel above the input */}
      {cmd.isOpen && (
        <box
          border={true}
          borderStyle="rounded"
          borderColor="#89B4FA"
          backgroundColor="#13131A"
          padding={1}
          flexDirection="column"
        >
          {/* header */}
          <box paddingX={1} paddingBottom={1}>
            <text attributes={TextAttributes.BOLD} fg="#89B4FA">
              Commands
            </text>
            <text attributes={TextAttributes.DIM} fg="#6B6B7B">
              {" "}· {"type to filter"}
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

      {/* input area */}
      <box
        paddingX={2}
        paddingY={1}
        backgroundColor="#1A1A24"
        gap={1}
        flexDirection="column"
      >
        <textarea
          ref={textareaRef}
          focused={!disabled}
          keyBindings={TEXTAREA_KEY_BINDINGS}
          placeholder={`Ask anything... " Fix a bug in the database" `}
          onContentChange={handleContentChange}
        />

        <StatusBar />
      </box>
    </box>
  );
}
