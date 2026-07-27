import type { RefObject } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";

import { getFiltererdCommands } from "./filter-commands";
import { COMMANDS } from "./commands";

const MAX_VISIBLE_ITEMS = 8;

type CommandMenuProps = {
    query : string;
    selectedIndex : number;
    scrollRef : RefObject<ScrollBoxRenderable |  null>;
    onSelect : (index : number) => void;
    onExecute : (index : number) => void;
}

export function CommandMenu(props : CommandMenuProps) {
    const { query, selectedIndex, scrollRef, onSelect, onExecute } = props;
    const filtered = getFiltererdCommands(query);
    const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);

    if(filtered.length === 0) {
        // show no matching commands
        return (
            <box paddingX={1}>
                <text attributes={TextAttributes.DIM}>no matching commands</text>
            </box>
        )
    };


    return (
        <scrollbox ref={scrollRef} height={visibleHeight}>
            {filtered.map((command, index) => {
                const isSelected = index === selectedIndex;
                return (
                    <box key={command.value} flexDirection="row" paddingX={1} height={1} overflow="hidden" backgroundColor={isSelected ? "#89B4FA" : undefined}
                    onMouseDown={() => onSelect(index)} onMouseMove={() => onExecute(index)}>
                        <text attributes={isSelected ? TextAttributes.BOLD : TextAttributes.DIM}>{command.name}</text>
                    </box>
                )
            })}
                
        </scrollbox>
    )
}

