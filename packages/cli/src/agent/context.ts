import Groq from "groq-sdk";
import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";
import type { ContextType, MessageType } from "./types";
import { logger } from "../logger";

const systemPrompt = `You are NightCode, a terminal-based AI coding agent that helps users understand, modify, and manage code and files on their local machine.

## Available tools

- read(file) — read the full contents of a file.
- write(file, content) — create or overwrite a file.
- append(file, content) — append content to a file.
- edit(file, oldText, newText) — replace an exact text match inside a file.
- delete(file) — permanently delete a file.
- mkdir(dir) — create a directory.
- ls(dir) — list directory contents.
- glob(pattern) — search files by glob.
- find(root, name) — recursively search for a filename.
- grep(pattern, path?, glob?, ignoreCase?) — search code using ripgrep.
- rename(from, to) — rename or move a file.
- copy(from, to) — copy a file.
- bash(command) — execute shell commands and return stdout, stderr and exit code.
- todoWrite(todos) — record and update a checklist plan for multi-step tasks (status: pending | in_progress | completed).

---

# Core Principles

- Never assume file contents, paths, APIs, or project structure.
- Investigate first, then modify.
- Use the minimum number of edits necessary.
- Preserve the user's existing code style and architecture.
- Never modify unrelated code.
- If a tool reports an error, treat it as ground truth instead of guessing.

---

# Working With Files

Before modifying an existing file:

1. Read it first.
2. Understand the surrounding context.
3. Edit only the required sections.

Prefer:

edit
>

write

because write replaces the entire file.

Only use write when:

- creating a new file
- replacing the entire contents intentionally

Never fabricate file contents.

If multiple candidate files exist, investigate before choosing.

---

# Tool Usage

Use tools instead of reasoning from assumptions.

Examples:

- use grep before guessing where something is implemented
- use glob/find before assuming filenames
- use bash for builds, tests, git, package managers and shell commands

Never describe tool calls in natural language.

Never output JSON or XML representing tool calls.

Only use the native tool calling interface.

---

# Repository Awareness

Assume the workspace is a Git repository.

When solving coding tasks:

- Use "git status" when repository state matters.
- Before declaring success, inspect your changes using "git diff" (or "git diff <file>".
- Never overwrite unrelated user modifications.
- Never commit, push, checkout, reset, clean, stash or rebase unless explicitly requested.

---

# Verification

Do not assume code works.

Whenever possible:

1. Run the relevant tests.
2. Run builds when appropriate.
3. Read compiler/runtime errors carefully.
4. Fix the root cause.
5. Repeat until verification succeeds.

Prefer running the smallest relevant test instead of an entire suite.

Before reporting completion, verify your implementation using Git diff and any relevant validation commands.

---

# Bash Usage

The Bash tool is your interface to the operating system.

Use it whenever appropriate, including:

- git
- rg
- npm
- pnpm
- yarn
- bun
- cargo
- go
- pytest
- uv
- make
- cmake
- docker
- kubectl

Prefer focused commands that produce concise output.

Avoid commands that generate excessive output unless necessary.

Never execute destructive shell commands unless explicitly requested.

---

# Communication

Keep responses short.

Do not narrate every step.

Only ask questions when blocked by genuine ambiguity.

When finished:

- briefly explain what changed
- mention any verification performed
- mention any remaining limitations if applicable

---

# Memory

An automatic background memory system exists.

Never read or modify files inside the memory directory.

Do not attempt to store memories manually.

Simply respond naturally.

---

# Safety

Never bypass confirmation for destructive operations.

Never attempt to circumvent tool restrictions.

If a requested operation is dangerous or irreversible, wait for explicit user confirmation.

Always prioritize preserving user data.`;

// ── Context window management ───────────────────────────────────────────
// Qwen 3.6 27B on Groq has a 131,072 token context window. We reserve
// ~30K for the system prompt, tool definitions, and output tokens, so the
// safe threshold for message history alone is ~100,000 tokens.
const CONTEXT_THRESHOLD_TOKENS = 100_000;
const PRESERVE_LAST_N          = 15;

// Rough token estimation: ~3 chars per token is a conservative estimate that
// works reasonably for both prose and code-heavy conversations. This is a
// heuristic, not an exact tokenizer — it deliberately errs on the side of
// triggering compression a little early rather than overflowing the window.
const CHARS_PER_TOKEN = 3;
const FLAT_OVERHEAD_PER_MSG = 10; // per-message framing overhead, same for all roles — precision beyond this is false confidence given the estimate is already approximate

// Model used for the (cheap) summarization call. Keep this small/fast —
// summarization is a compression task, not a reasoning task.
const SUMMARIZER_MODEL = "llama-3.1-8b-instant";
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
async function summarizeMessages(messages: MessageType[], groqClient: Groq): Promise<string> {
    const rawTrace = messages
        .map((m) => {
            if (m.role === "tool") return `[tool result] ${(m.content ?? "").slice(0, 300)}`;
            if (m.toolCalls?.length) return `[assistant used tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`;
            return `[${m.role}] ${(m.content ?? "").slice(0, 300)}`;
        })
        .join("\n");

    try {
        const completion = await groqClient.chat.completions.create({
            model: SUMMARIZER_MODEL,
            temperature: 0,
            messages: [
                {
                    role: "user",
                    content:
                        `Summarize the following agent conversation history in under ${SUMMARY_MAX_WORDS} words. ` +
                        `Preserve concrete facts, file paths touched, decisions made, and outcomes (what succeeded/failed). ` +
                        `Do not add commentary or preamble — output only the summary itself.\n\n${rawTrace}`,
                },
            ],
        });

        const summary = completion.choices[0]?.message?.content?.trim();
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
    groqClient: Groq,
    existingSummary?: string
): Promise<{ messages: MessageType[]; summary?: string }> {
    if (messages.length === 0) return { messages, summary: existingSummary };

    const estimated = estimateMessagesTokens(messages);
    logger.debug(`[Context] Estimated ${messages.length} messages @ ~${estimated} tokens`);

    if (estimated <= CONTEXT_THRESHOLD_TOKENS) {
        return { messages, summary: existingSummary }; // fits — no compression needed
    }

    const preserveCount = Math.min(PRESERVE_LAST_N, messages.length - 1);
    const olderMessages  = messages.slice(0, messages.length - preserveCount);
    let recentMessages    = messages.slice(messages.length - preserveCount);

    logger.info(
        `[Context] Exceeded threshold (${estimated} > ${CONTEXT_THRESHOLD_TOKENS}). ` +
        `Summarizing ${olderMessages.length} old messages, preserving ${recentMessages.length} recent messages.`
    );

    const newSummaryText = await summarizeMessages(olderMessages, groqClient);

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
        if (estimateMessagesTokens(testMessages) <= CONTEXT_THRESHOLD_TOKENS) break;
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
        private groqClient: Groq
    ) {
        logger.debug("ContextBuilder constructed");
    }

    async build(sessionId: string, memoryContext?: string): Promise<ContextType> {
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
        const { messages, summary } = await manageContextWindow(rawMessages, this.groqClient, existing?.summary);

        if (summary && summary !== existing?.summary) {
            const lastMessageId = rawMessages[rawMessages.length - 1]?.messageId ?? "";
            this.sessionSummaries.set(sessionId, { summary, summarizedUpToMessageId: lastMessageId });
        }

        logger.info(
            `[ContextBuilder] Messages after window management: ${messages.length} ` +
            `(${rawMessages.length} raw — ${rawMessages.length - messages.length} compressed)`
        );

        // Map internal Tool → Groq's ChatCompletionTool shape
        const toolList = this.toolRegistry.list();
        const tools: Groq.Chat.Completions.ChatCompletionTool[] = toolList
            .map((tool) => ({
                type: "function" as const,
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            }));

        let resolvedSystemPrompt = systemPrompt;
        if (memoryContext) {
            resolvedSystemPrompt = `${systemPrompt}\n\n${memoryContext}`;
        }
        logger.debug(`[ContextBuilder] Context ready — ${messages.length} messages, ${tools.length} tools`);

        return {
            sessionId,
            model: session.model,
            messages,
            tools,
            systemPrompt: resolvedSystemPrompt,
        };
    }
}