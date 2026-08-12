// ui/model-menu/preferences.ts — favorites + recents persistence.
//
// Stored per-user at ~/.nightcode/model-preferences.json (never in the repo —
// these are preferences, not project config). All file access is guarded: a
// corrupt/unwritable file degrades to empty preferences, never a crash.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export type ModelPrefs = {
    favorites: string[];
    recents: string[];
};

const MAX_RECENTS = 8;

function prefsPath(): string {
    return join(homedir(), ".nightcode", "model-preferences.json");
}

export function loadModelPrefs(): ModelPrefs {
    try {
        const path = prefsPath();
        if (!existsSync(path)) return { favorites: [], recents: [] };
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelPrefs>;
        return {
            favorites: Array.isArray(raw.favorites)
                ? raw.favorites.filter((x): x is string => typeof x === "string")
                : [],
            recents: Array.isArray(raw.recents)
                ? raw.recents.filter((x): x is string => typeof x === "string")
                : [],
        };
    } catch {
        return { favorites: [], recents: [] };
    }
}

export function saveModelPrefs(prefs: ModelPrefs): void {
    try {
        const path = prefsPath();
        mkdirSync(join(homedir(), ".nightcode"), { recursive: true });
        writeFileSync(path, JSON.stringify(prefs, null, 2), "utf-8");
    } catch {
        // non-fatal — favorites just won't persist across restarts
    }
}

/** Record a selection: dedupe, move to front, cap the list. */
export function pushRecent(recents: string[], key: string): string[] {
    return [key, ...recents.filter((r) => r !== key)].slice(0, MAX_RECENTS);
}

export function toggleFavorite(favorites: string[], key: string): string[] {
    return favorites.includes(key)
        ? favorites.filter((f) => f !== key)
        : [...favorites, key];
}
