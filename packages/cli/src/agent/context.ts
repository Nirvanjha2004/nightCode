import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";
import type { ContextType, MessageType } from "./types";
import type { ChatLLM } from "../llm-client/types";
import { logger } from "../logger";

// ── System prompt (Pi-style, compact) ────────────────────────────────────
// Matches the Pi coding agent's prompt shape: a short identity line, the
// available-tools list (one-line snippets built from the ACTUAL tool surface
// so the prompt and the native tool-calling definitions never drift), a few
// guidelines, and the working directory. The full memory context is still
// appended below when available — memory stays a NightCode feature.
const baseSystemPrompt = `You are an expert coding assistant operating inside NightCode, a terminal-based coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Never assume file contents, paths, or project structure — investigate first, then modify
- Prefer edit over write when modifying existing files
- Use git status and git diff to verify changes before declaring success
- Run the smallest relevant test or build to verify your work
- Never read or modify files inside the memory/ directory, and never try to store memories manually
- Destructive operations require user confirmation — never bypass it`;

/** One-line prompt snippets for the model-visible tool surface (Pi-style). */
const TOOL_SNIPPETS: Record<string, string> = {
    read: "Read the full text contents of a file. Use before editing or inspecting any file.",
    write: "Create a new file, or overwrite an existing one (replaces the ENTIRE file — prefer edit for changes).",
    edit: "Replace one exact occurrence of oldText with newText inside a file. Preferred for targeted changes.",
    bash: "Run a shell command (tests, builds, git, package managers, etc.); returns stdout, stderr, exit code.",
    grep: "Search the contents of files with ripgrep — every file and line matching a regex pattern.",
    find: "Recursively search for files by exact name under a directory.",
    ls: "List the immediate contents (files and subdirectories) of a directory.",
    todoWrite: "Record and update a checklist plan for multi-step tasks as work progresses.",
    spawn_subagent: "Delegate a self-contained sub-task to a fresh isolated agent; only its final summary returns.",
};

/**
 * The model-visible tool surface — Pi's default set (read, write, edit, bash,
 * grep, find, ls) plus NightCode's subagent delegation and task planning. The
 * remaining tools (append, delete, mkdir, glob, rename, copy) stay registered
 * and executable but are NOT advertised to the model, keeping the surface
 * lean. Restricting happens here, in the context builder, so no tool code,
 * registration order, or subagent scoping needs to change.
 */
const VISIBLE_TOOLS = new Set([
    "read", "write", "edit", "bash", "grep", "find", "ls",
    "todoWrite", "spawn_subagent",
]);

// ── Context window management ───────────────────────────────────────────
// The compression threshold is derived from the ACTIVE model's context window
// (reserve ~25% for system prompt, tool definitions, and output), so a 1M
// window compresses later than the old fixed 100k did for a 131k model.
const CONTEXT_RESERVE_RATIO    = 0.75;
const CONTEXT_THRESHOLD_MIN    = 32_000;
const PRESERVE_LAST_N          = 15;

// Rough token estimation: ~3 chars per token is a conservative estimate that
// works reasonably for both prose and code-heavy conversations. This is a
// heuristic, not an exact tokenizer — it deliberately errs on the side of
// triggering compression a little early rather than overflowing the window.
const CHARS_PER_TOKEN = 3;
const FLAT_OVERHEAD_PER_MSG = 10; // per-message framing overhead, same for all roles — precision beyond this is false confidence given the estimate is already approximate

// Summarization uses the ACTIVE provider's cheap summarizer model (per-provider
// presets pick a small/fast one; defaults to the main model when unset).
const SUMMARY_MAX_WORDS = 400;

function estimateTokens(text: string): number {
    return Math.ceil((text ?? "").length / CHARS_PER_TOKEN);
}

function estimateMessagesTokens(messages: MessageType[]): number {
    return messages.reduce((sum, msg) => {
        let tokens = estimateTokens(msg.content) + FLAT_OVERHEAD_PER_MSG;

        if (msg.toolCalls?.length) {
            for (const tc of msg.toolCalls) {
                tokens += estimateTokens(tc.name + JSON.stringify(tc.args));
            }
        }
        return sum + tokens;
    }, 0);
}

// Turns a batch of older messages into a short LLM-generated summary,
// rather than naive truncation. This is the actual "compression" step —
// it preserves meaning (what was asked, what was done, what was decided)
// instead of just chopping strings.
async function summarizeMessages(messages: MessageType[], llm: ChatLLM, model: string): Promise<string> {
    const rawTrace = messages
        .map((m) => {
            if (m.role === "tool") return `[tool result] ${(m.content ?? "").slice(0, 300)}`;
            if (m.toolCalls?.length) return `[assistant used tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`;
            return `[${m.role}] ${(m.content ?? "").slice(0, 300)}`;
        })
        .join("\n");

    try {
        const response = await llm.chat({
            sessionId: messages[0]?.sessionId ?? "summary",
            model,
            systemPrompt: "",
            messages: [
                {
                    messageId: "summarize",
                    sessionId: messages[0]?.sessionId ?? "summary",
                    role: "user",
                    content:
                        `Summarize the following agent conversation history in under ${SUMMARY_MAX_WORDS} words. ` +
                        `Preserve concrete facts, file paths touched, decisions made, and outcomes (what succeeded/failed). ` +
                        `Do not add commentary or preamble — output only the summary itself.\n\n${rawTrace}`,
                    createdAt: new Date(),
                },
            ],
            tools: [],
        });

        const summary = response.type === "text" ? response.content.trim() : "";
        if (!summary) throw new Error("Empty summary returned");
        return summary;
    } catch (err) {
        logger.error(`[Context] Summarization call failed, falling back to truncated concat: ${err instanceof Error ? err.message : String(err)}`);
        // fallback: if the summarizer call fails for any reason, degrade gracefully
        // to a truncated concatenation rather than losing the compression step entirely
        return messages
            .map((m) => `[${m.role}] ${(m.content ?? "").slice(0, 150)}`)
            .join("\n");
    }
}

async function manageContextWindow(
    messages: MessageType[],
    llm: ChatLLM,
    contextLimitTokens: number,
    existingSummary?: string
): Promise<{ messages: MessageType[]; summary?: string }> {
    if (messages.length === 0) return { messages, summary: existingSummary };

    const threshold = Math.max(CONTEXT_THRESHOLD_MIN, Math.floor(contextLimitTokens * CONTEXT_RESERVE_RATIO));
    const estimated = estimateMessagesTokens(messages);
    logger.debug(`[Context] Estimated ${messages.length} messages @ ~${estimated} tokens (threshold ${threshold})`);

    if (estimated <= threshold) {
        return { messages, summary: existingSummary }; // fits — no compression needed
    }

    const preserveCount = Math.min(PRESERVE_LAST_N, messages.length - 1);
    const olderMessages  = messages.slice(0, messages.length - preserveCount);
    let recentMessages    = messages.slice(messages.length - preserveCount);

    logger.info(
        `[Context] Exceeded threshold (${estimated} > ${threshold}). ` +
        `Summarizing ${olderMessages.length} old messages, preserving ${recentMessages.length} recent messages.`
    );

    const newSummaryText = await summarizeMessages(olderMessages, llm, llm.summarizerModel());

    // Chain with any prior summary so context isn't lost across repeated compressions
    const combinedSummary = existingSummary
        ? `${existingSummary}\n\n${newSummaryText}`
        : newSummaryText;

    let summaryMsg: MessageType = {
        messageId: "context-summary",
        sessionId: messages[0]?.sessionId ?? "summary",
        role: "system",
        content: `## Previous conversation summary\n${combinedSummary}`,
        createdAt: new Date(),
    };

    // Safety: if summary + recent messages is still too long, drop earliest preserved messages.
    // n <= PRESERVE_LAST_N (15), so this is cheap even though it's O(n) per iteration.
    while (recentMessages.length > 2) {
        const testMessages = [summaryMsg, ...recentMessages];
        if (estimateMessagesTokens(testMessages) <= threshold) break;
        recentMessages = recentMessages.slice(1);
    }

    // Final safety net: hard-truncate the summary itself if it's still oversized
    // (should rarely trigger given SUMMARY_MAX_WORDS, but protects against a
    // summarizer that ignores the word-limit instruction)
    while (estimateTokens(summaryMsg.content) > 8000) {
        summaryMsg = { ...summaryMsg, content: summaryMsg.content.slice(0, summaryMsg.content.length - 500) };
    }

    return { messages: [summaryMsg, ...recentMessages], summary: combinedSummary };
}

// ── ContextBuilder ──────────────────────────────────────────────────────

export class ContextBuilder {
    // Tracks the running compressed summary per session, so we don't
    // re-summarize the same old messages on every single call.
    private sessionSummaries = new Map<string, { summary: string; summarizedUpToMessageId: string }>();

    constructor(
        private messageManager: MessageManager,
        private sessionManager: SessionManager,
        private toolRegistry: ToolRegistry,
        /** The provider router — used only for context summarization. */
        private chatLLM: ChatLLM
    ) {
        logger.debug("ContextBuilder constructed");
    }

    async build(sessionId: string, memoryContext?: string, allowedTools?: string[], resolvedUserInput?: string): Promise<ContextType> {
        logger.debug(`[ContextBuilder] Building context for session=${sessionId}`);

        const session = this.sessionManager.get(sessionId);

        if (!session) {
            logger.error(`[ContextBuilder] Session not found: ${sessionId}`);
            throw new Error(`Session ${sessionId} not found`);
        }

        const rawMessages = this.messageManager.get(sessionId);
        logger.debug(`[ContextBuilder] Session "${sessionId}" — model=${session.model}, rawMessageCount=${rawMessages.length}`);

        // ── Apply context window management (with session-level summary reuse) ──
        const existing = this.sessionSummaries.get(sessionId);
        const contextLimit = this.chatLLM.contextLimit(session.model);
        const { messages, summary } = await manageContextWindow(rawMessages, this.chatLLM, contextLimit, existing?.summary);

        if (summary && summary !== existing?.summary) {
            const lastMessageId = rawMessages[rawMessages.length - 1]?.messageId ?? "";
            this.sessionSummaries.set(sessionId, { summary, summarizedUpToMessageId: lastMessageId });
        }

        logger.info(
            `[ContextBuilder] Messages after window management: ${messages.length} ` +
            `(${rawMessages.length} raw — ${rawMessages.length - messages.length} compressed)`
        );

        // Slash commands: stored history keeps the original raw input (e.g. "/review")
        // while the model must receive the resolved prompt. Substitute the last user
        // message in the context window only — never mutate the stored history.
        let modelMessages = messages;
        if (resolvedUserInput !== undefined) {
            const last = messages[messages.length - 1];
            if (last && last.role === "user") {
                modelMessages = [...messages.slice(0, -1), { ...last, content: resolvedUserInput }];
            }
        }

        // Map internal Tool → the neutral wire shape (adapters convert further).
        // Tool restrictions are enforced here: restricted tools are not merely
        // "discouraged" in the prompt, they are excluded from the tool list the
        // model actually receives. On top of the allowedTools scope, the surface
        // is capped to VISIBLE_TOOLS (Pi-style lean surface) — hidden tools stay
        // registered for slash-command scopes and subagents but are never
        // advertised to the model.
        const toolList = this.toolRegistry
            .listFiltered(allowedTools)
            .filter((tool) => VISIBLE_TOOLS.has(tool.name));
        // A scope that requested a hidden tool silently drops it — log so a
        // "context with 0 tools" is diagnosable instead of mysterious.
        if (allowedTools) {
            const dropped = allowedTools.filter((name) => !VISIBLE_TOOLS.has(name));
            if (dropped.length > 0) {
                logger.debug(
                    `[Context] allowed-tools scope asked for ${dropped.join(", ")} — hidden by the model-visible surface (registered, not advertised)`
                );
            }
        }
        const tools: ContextType["tools"] = toolList
            .map((tool) => ({
                type: "function" as const,
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            }));

        // Pi-style prompt composition: the "Available tools" list mirrors the
        // actual (filtered) surface, so the prompt and the native tool-calling
        // definitions always agree.
        const availableTools = toolList.length
            ? toolList.map((tool) => `- ${tool.name}: ${TOOL_SNIPPETS[tool.name] ?? tool.description}`).join("\n")
            : "(none)";
        let resolvedSystemPrompt =
            `${baseSystemPrompt}\n\nAvailable tools:\n${availableTools}` +
            // process.cwd() is what read/write/bash actually resolve relative
            // paths against — never claim PROJECT_ROOT here.
            `\n\nCurrent working directory: ${process.cwd()}`;
        if (memoryContext) {
            resolvedSystemPrompt = `${resolvedSystemPrompt}\n\n${memoryContext}`;
        }
        logger.debug(`[ContextBuilder] Context ready — ${modelMessages.length} messages, ${tools.length} tools`);

        return {
            sessionId,
            model: session.model,
            messages: modelMessages,
            tools,
            systemPrompt: resolvedSystemPrompt,
        };
    }
}
