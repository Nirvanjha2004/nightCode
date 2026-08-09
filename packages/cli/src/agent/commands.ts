import matter from "gray-matter";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../logger";

export interface CommandDefinition {
    name: string;
    description?: string;
    allowedTools?: string[];
    argumentHint?: string;
    body: string;
}

export class CommandRegistry {
    private commands = new Map<string, CommandDefinition>();

    /**
     * Scans the commands directory for `<name>.md` files and registers each as
     * command `name`. The directory is resolved independent of the launch cwd
     * (see `resolveCommandsDir`), so running from `packages/cli` still finds
     * the repo-root `commands/` folder. A missing directory is not fatal — the
     * registry stays empty and the application keeps booting. A malformed file
     * is logged and skipped so one bad command cannot take down startup.
     */
    async loadFromDir(dir: string): Promise<void> {
        const resolvedDir = resolveCommandsDir(dir) ?? dir;
        let files: string[];
        try {
            files = await readdir(resolvedDir);
        } catch (err) {
            logger.warn(`[CommandRegistry] Command directory "${dir}" not found (searched parent dirs too) — 0 commands loaded`);
            return;
        }

        for (const file of files) {
            if (!file.endsWith(".md")) continue;

            const name = file.slice(0, -3);
            try {
                const { data, content } = matter(await readFile(join(resolvedDir, file), "utf-8"));
                const definition: CommandDefinition = {
                    name,
                    description: typeof data.description === "string" ? data.description : undefined,
                    allowedTools: parseAllowedTools(data["allowed-tools"]),
                    argumentHint: typeof data["argument-hint"] === "string" ? data["argument-hint"] : undefined,
                    body: content.trim(),
                };
                this.commands.set(name, definition);
                logger.info(`[CommandRegistry] Loaded command "/${name}"`);
            } catch (err) {
                logger.error(`[CommandRegistry] Failed to load command "${name}": ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        logger.info(`[CommandRegistry] ${this.commands.size} command(s) loaded from "${resolvedDir}"`);
    }

    get(name: string): CommandDefinition | undefined {
        return this.commands.get(name);
    }

    list(): CommandDefinition[] {
        return [...this.commands.values()];
    }
}

/**
 * Resolves a user message into the prompt the model should receive.
 *
 * A slash command is purely an input transformation: the command body becomes
 * the user message (with every `$ARGUMENTS` occurrence replaced by the parsed
 * argument string), and the command definition optionally scopes the tools.
 * There is no separate execution path — resolution happens before the existing
 * AgentLoop flow and everything else proceeds as usual.
 *
 * Unknown commands do NOT throw or crash: `/doesnotexist` is treated as a
 * normal user message and passed through unchanged.
 *
 * Known limitation: slash-prefixed paths (e.g. `/home/user/file.ts`) look like
 * commands, but the first token must match a registered command name, so paths
 * pass through unchanged. No path-vs-command heuristics on purpose.
 */
export function resolveSlashCommand(
    rawInput: string,
    registry: CommandRegistry
): { resolvedInput: string; activeCommand?: CommandDefinition } {
    if (!rawInput.startsWith("/")) {
        return { resolvedInput: rawInput };
    }

    // Command name is the first token; everything after the first space is
    // the argument string, preserved as-is (including extra spaces).
    const spaceIdx = rawInput.indexOf(" ");
    const name = spaceIdx === -1 ? rawInput.slice(1) : rawInput.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : rawInput.slice(spaceIdx + 1);

    const command = registry.get(name);
    if (!command) {
        return { resolvedInput: rawInput };
    }

    return {
        resolvedInput: command.body.replaceAll("$ARGUMENTS", args),
        activeCommand: command,
    };
}

/**
 * Resolves the commands directory regardless of where the app is launched from.
 *
 * 1. `dir` as given (cwd-relative or absolute).
 * 2. Walk up from the cwd looking for a `commands` directory — nearest ancestor
 *    wins, so a project that ships its own `commands/` folder takes precedence
 *    over the bundled ones. This is also the fix for launching from
 *    `packages/cli`, where the plain `commands/` path used to resolve to a
 *    nonexistent folder and load zero commands.
 * 3. Fall back to this module's location (the repo root), so the bundled
 *    commands always load even when the app is started from outside the repo.
 *
 * Returns undefined only when no commands directory exists anywhere up the
 * tree; `loadFromDir` then logs a warning and stays empty.
 */
function resolveCommandsDir(dir: string): string | undefined {
    if (existsSync(dir)) return dir;
    return walkUpForDir(process.cwd(), dir) ?? walkUpForDir(import.meta.dir, dir);
}

function walkUpForDir(start: string, dir: string): string | undefined {
    let current = start;
    for (;;) {
        const candidate = join(current, dir);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(current);
        if (parent === current) return undefined; // reached the filesystem root
        current = parent;
    }
}

function parseAllowedTools(raw: unknown): string[] | undefined {
    if (typeof raw !== "string") return undefined;
    const tools = raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    return tools.length > 0 ? tools : undefined;
}
