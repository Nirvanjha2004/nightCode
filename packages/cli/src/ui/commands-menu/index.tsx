import type { RefObject } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";

import { getFiltererdCommands } from "./filter-commands";
import type { Command } from "./types";
import { C } from "../theme";

const MAX_VISIBLE_ITEMS = 8;

type CommandMenuProps = {
    query : string;
    commands : Command[];
    selectedIndex : number;
    scrollRef : RefObject<ScrollBoxRenderable |  null>;
    onSelect : (index : number) => void;
    onExecute : (index : number) => void;
}

export function CommandMenu(props : CommandMenuProps) {
    const { query, commands, selectedIndex, scrollRef, onSelect, onExecute } = props;
    const filtered = getFiltererdCommands(query, commands);
    const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);

    if(filtered.length === 0) {
        return (
            <box paddingX={1} paddingY={1}>
                <text attributes={TextAttributes.DIM} fg={C.muted}>no matching commands</text>
            </box>
        )
    };

    return (
        <scrollbox
          ref={scrollRef}
          height={visibleHeight}
        >
            {filtered.map((command, index) => {
                const isSelected = index === selectedIndex;
                return (
                    <box
                      key={command.value}
                      flexDirection="row"
                      paddingX={1}
                      height={1}
                      overflow="hidden"
                      backgroundColor={isSelected ? C.accent : undefined}
                      onMouseDown={() => onSelect(index)}
                      onMouseMove={() => onExecute(index)}
                    >
                        {/* The selected row is a solid accent fill rather than a
                            marker column: it reads at a glance while scanning, and
                            costs no horizontal space on a narrow terminal. */}
                        <text
                          attributes={TextAttributes.BOLD}
                          fg={isSelected ? C.onAccent : C.text}
                          wrapMode="none"
                        >
                            {command.name}
                        </text>
                        <text
                          attributes={TextAttributes.DIM}
                          fg={isSelected ? C.onAccent : C.faint}
                          wrapMode="none"
                        >
                            {" "}
                            {command.value}
                        </text>
                    </box>
                )
            })}
        </scrollbox>
    )
}
