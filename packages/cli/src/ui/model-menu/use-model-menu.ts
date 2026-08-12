import { useCallback, useMemo, useState } from "react";
import { loadModelPrefs, pushRecent, saveModelPrefs, toggleFavorite, type ModelPrefs } from "./preferences";
import type { ModelMenuData, ModelMenuRow } from "./types";

export type ModelMenuController = ReturnType<typeof useModelMenu>;

export function useModelMenu(getData: () => ModelMenuData, activeKey: string) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [providerFilter, setProviderFilter] = useState("all"); // "all" | providerId
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [prefs, setPrefs] = useState<ModelPrefs>(() => loadModelPrefs());

    // Flatten providers × models into selectable rows. Rebuilt on every open
    // so dynamic discovery results and auth status are fresh.
    const rows = useMemo<ModelMenuRow[]>(() => {
        const data = getData();
        const out: ModelMenuRow[] = [];
        for (const p of data.providers) {
            for (const m of p.models) {
                out.push({
                    providerId: p.id,
                    providerName: p.displayName,
                    authOk: p.authOk,
                    modelId: m.id,
                    name: m.name,
                    contextWindow: m.contextWindow,
                    reasoning: m.reasoning,
                    vision: m.vision,
                    key: `${p.id}/${m.id}`,
                });
            }
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getData, isOpen, activeKey]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return rows.filter((row) => {
            if (providerFilter !== "all" && row.providerId !== providerFilter) return false;
            if (!q) return true;
            return (
                row.modelId.toLowerCase().includes(q) ||
                row.name.toLowerCase().includes(q) ||
                row.providerName.toLowerCase().includes(q)
            );
        });
    }, [rows, query, providerFilter]);

    // Recently used rows (shown above the full list when there is no query).
    const recents = useMemo(() => {
        if (query.trim()) return [];
        const byKey = new Map(rows.map((r) => [r.key, r]));
        return prefs.recents
            .map((k) => byKey.get(k))
            .filter((r): r is ModelMenuRow => !!r)
            .slice(0, 6);
    }, [rows, query, prefs.recents]);

    const open = useCallback((initialQuery = "") => {
        setQuery(initialQuery);
        setProviderFilter("all");
        setSelectedIndex(0);
        setIsOpen(true);
    }, []);

    const close = useCallback(() => {
        setIsOpen(false);
        setQuery("");
    }, []);

    const setQueryText = useCallback((text: string) => {
        setQuery(text);
        setSelectedIndex(0);
    }, []);

    const navigateUp = useCallback(() => {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
    }, []);

    const navigateDown = useCallback(() => {
        setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
    }, [filtered.length]);

    /** Cycle the provider filter: All → each provider in turn → All. */
    const cycleProvider = useCallback(
        (providers: string[]) => {
            setProviderFilter((current) => {
                const ids = ["all", ...providers];
                const idx = ids.indexOf(current);
                return ids[(idx + 1) % ids.length] ?? "all";
            });
            setSelectedIndex(0);
        },
        []
    );

    const toggleFav = useCallback(
        (key: string) => {
            setPrefs((prev) => {
                const next = { ...prev, favorites: toggleFavorite(prev.favorites, key) };
                saveModelPrefs(next);
                return next;
            });
        },
        []
    );

    const recordSelection = useCallback((key: string) => {
        setPrefs((prev) => {
            const next = { ...prev, recents: pushRecent(prev.recents, key) };
            saveModelPrefs(next);
            return next;
        });
    }, []);

    const isFavorite = useCallback((key: string) => prefs.favorites.includes(key), [prefs.favorites]);

    const providerIds = useMemo(() => {
        const seen = new Set<string>();
        for (const r of rows) seen.add(r.providerId);
        return [...seen];
    }, [rows]);

    return {
        isOpen,
        open,
        close,
        query,
        setQueryText,
        providerFilter,
        cycleProvider,
        filtered,
        recents,
        selectedIndex,
        navigateUp,
        navigateDown,
        toggleFav,
        isFavorite,
        recordSelection,
        providerIds,
        prefs,
    };
}
