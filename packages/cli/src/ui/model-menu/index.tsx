// ui/model-menu/index.tsx — the model selector.
//
// Keyboard: ↑/↓ (or Ctrl+P/Ctrl+N) navigate · Enter selects · Esc closes ·
// Tab cycles the provider filter · Ctrl+F favorites the selected row.
// The active model is marked ✓; providers without credentials are dimmed with
// a 🔒 hint; favorites get ⭐; recent selections are pinned at the top.

import { useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import type { ModelMenuRow } from "./types";
import type { ModelMenuController } from "./use-model-menu";
import { C, G } from "../theme";

type DisplayRow =
    | { kind: "header"; label: string }
    | { kind: "model"; row: ModelMenuRow; isActive: boolean; isFav: boolean };

const WINDOW = 5;

function fmtCtx(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return String(tokens);
}

function ModelRowView({ row, isActive, isFav, selected, onFav }: {
    row: ModelMenuRow;
    isActive: boolean;
    isFav: boolean;
    selected: boolean;
    onFav: (key: string) => void;
}) {
    const badges: string[] = [];
    if (row.reasoning) badges.push("🧠");
    if (row.vision) badges.push("👁");
    const badgeText = badges.length ? " " + badges.join("") : "";

    return (
        <box flexDirection="row" paddingX={1} height={1} overflow="hidden"
            backgroundColor={selected ? C.accent : undefined}
            onMouseDown={() => onFav(row.key)}
        >
            <text attributes={selected ? TextAttributes.BOLD : undefined}
                fg={selected ? C.onAccent : isActive ? C.success : row.authOk ? C.text : C.faint}
                wrapMode="none">
                {isActive ? `${G.ok} ` : "  "}
                {row.modelId}
            </text>
            <text attributes={TextAttributes.DIM} fg={selected ? C.onAccent : C.muted} wrapMode="none">
                {" · "}{row.providerName}{badgeText}
                {!row.authOk ? " · 🔒 no key" : ""}
            </text>
            <text attributes={TextAttributes.DIM} fg={selected ? C.onAccent : C.faint} wrapMode="none">
                {" · "}{fmtCtx(row.contextWindow)}
            </text>
            <text fg={selected ? C.onAccent : C.warn} wrapMode="none">
                {isFav ? " ⭐" : ""}
            </text>
        </box>
    );
}

export function ModelMenu({ menu, activeKey, onSelect }: {
    menu: ModelMenuController;
    activeKey: string;
    onSelect: (providerId: string, modelId: string) => void;
}) {
    const { filtered, recents, selectedIndex, providerFilter, providerIds } = menu;

    const display = useMemo<DisplayRow[]>(() => {
        const out: DisplayRow[] = [];
        if (recents.length) {
            out.push({ kind: "header", label: "Recents" });
            for (const r of recents) {
                out.push({ kind: "model", row: r, isActive: r.key === activeKey, isFav: menu.isFavorite(r.key) });
            }
            out.push({ kind: "header", label: "All models" });
        }
        let lastProvider = "";
        for (const row of filtered) {
            if (row.providerId !== lastProvider) {
                lastProvider = row.providerId;
                out.push({ kind: "header", label: row.providerName });
            }
            out.push({ kind: "model", row, isActive: row.key === activeKey, isFav: menu.isFavorite(row.key) });
        }
        return out;
    }, [filtered, recents, activeKey, menu]);

    // The selection index points into `filtered`; find its position in display.
    const selectedRow = filtered[selectedIndex];
    const selectedDisplayIdx = selectedRow
        ? display.findIndex((d) => d.kind === "model" && d.row.key === selectedRow.key)
        : -1;
    const start = Math.max(0, Math.min(selectedDisplayIdx - WINDOW, display.length - (2 * WINDOW + 1)));
    const visible = display.slice(Math.max(0, start), start + 2 * WINDOW + 1);

    const filterLabel =
        providerFilter === "all" ? "All" : providerIds.includes(providerFilter)
            ? providerFilter
            : "All";

    return (
        <box paddingX={1} flexDirection="column">
            <box
                border={true}
                borderStyle="rounded"
                borderColor={C.line}
                backgroundColor={C.panel}
                paddingX={1}
                flexDirection="column"
            >
                {/* Header */}
                <box paddingX={1} flexDirection="row" gap={1} alignItems="center">
                    <text attributes={TextAttributes.BOLD} fg={C.accent} wrapMode="none">Models</text>
                    <text attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none" truncate>
                        · type to filter · tab provider ({filterLabel}) · ^f favorite
                    </text>
                </box>

                {/* Search query */}
                <box paddingX={1} paddingTop={1} flexDirection="row" gap={1}>
                    <text fg={C.accent2} attributes={TextAttributes.BOLD} wrapMode="none">{G.pointer}</text>
                    <text fg={menu.query ? C.bright : C.faint} wrapMode="none" truncate>
                        {menu.query || "search…"}
                    </text>
                </box>

                {/* List */}
                <box paddingX={1} flexDirection="column">
                    {visible.map((d, i) =>
                        d.kind === "header" ? (
                            // Three spaces, not two: the rows below carry a column
                            // of padding plus a two-cell ✓ slot, so the group label
                            // only lines up with the model names at this indent.
                            <text key={`h${i}`} attributes={TextAttributes.DIM} fg={C.faint} wrapMode="none">
                                {"   "}{d.label}
                            </text>
                        ) : (
                            <ModelRowView
                                key={d.row.key}
                                row={d.row}
                                isActive={d.isActive}
                                isFav={d.isFav}
                                selected={d.row.key === selectedRow?.key}
                                onFav={menu.toggleFav}
                            />
                        )
                    )}
                    {filtered.length === 0 && recents.length === 0 && (
                        <text attributes={TextAttributes.DIM} fg={C.muted} paddingX={1}>
                            no matching models
                        </text>
                    )}
                </box>

                {/* Footer: selected model info */}
                {selectedRow && (
                    <box
                        paddingX={1}
                        marginTop={1}
                        border={["top"]}
                        borderColor={C.line}
                        flexDirection="row"
                        gap={1}
                    >
                        <text attributes={TextAttributes.BOLD} fg={C.success} wrapMode="none" truncate>
                            {selectedRow.modelId}
                        </text>
                        <text attributes={TextAttributes.DIM} fg={C.muted} wrapMode="word">
                            · {selectedRow.providerName} · {fmtCtx(selectedRow.contextWindow)} ctx
                            {selectedRow.reasoning ? " · reasoning" : ""}
                            {selectedRow.vision ? " · vision" : ""}
                            {selectedRow.authOk ? "" : " · no key configured"}
                        </text>
                    </box>
                )}
            </box>
        </box>
    );
}
