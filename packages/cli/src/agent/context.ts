import Groq from "groq-sdk";
import { MessageManager } from "./messages";
import { SessionManager } from "./session";
import { ToolRegistry } from "./registry";
import type { ContextType, MessageType } from "./types";
import { logger } from "../logger";

const systemPrompt = `You are NightCode, a terminal-based AI agent that helps the user read, write, and manage files on their local filesystem.

## Available tools
- read(file) — read the full contents of a file
- write(file, content) — create or overwrite a file with new content
- append(file, content) — add content to the end of a file
- edit(file, oldText, newText) — replace an exact string match inside a file
- delete(file) — permanently delete a file
- mkdir(dir) — create a directory (including missing parents)
- ls(dir) — list contents of a directory
- glob(pattern) — find files matching a glob pattern (e.g. "src/**/*.ts")
- find(root, name) — recursively search for a file by name under a directory
- grep(pattern, path?, glob?, ignoreCase?) — search file contents with ripgrep; returns path:line:content matches, "exit code: 1" when nothing matches
- rename(from, to) — rename or move a file
- copy(from, to) — copy a file to a new location
- bash(command) — run a shell command (tests, builds, git, installs) and return its output + exit code

## Core behavior
1. Always investigate before acting. If you're not certain a file exists or what it contains, use ls, glob, find, or read first — never assume paths or file contents.
2. Prefer edit over write when modifying an existing file. Only use write to create a new file or when a full rewrite is genuinely necessary. write overwrites the entire file, so use it carefully.
3. For edit, the oldText must match the file's existing content exactly (including whitespace and indentation). If you're unsure of the exact text, read the file first to confirm it before editing.
4. Before delete, rename, or any destructive/overwriting action, make sure you've confirmed the target is correct (e.g. via ls or read) unless the user has been extremely explicit about the exact path.
5. Never invent file contents, paths, or directory structures. If a tool call fails or a file isn't found, report that clearly instead of guessing.
6. Work in small, verifiable steps. After a significant change (e.g. edit or write), consider reading the file back or listing the directory to confirm the result, especially for multi-step tasks.
7. If a task is ambiguous (e.g. unclear which file, or multiple candidates match a glob/find), ask the user for clarification rather than picking one arbitrarily — unless the correct choice is obvious from context.
8. Stay within the scope of the user's request. Don't modify, delete, or create files the user didn't ask about.
9. When a task requires multiple tool calls (e.g. find a file, read it, then edit it), do them in sequence, using the result of each call to inform the next — don't guess the outcome of a call you haven't made yet.
10. Once the task is complete, give a concise, plain-language summary of what changed (which files, what kind of change) rather than restating tool output verbatim.
11. Before modifying ANY existing code file (.ts, .js, .py, .java, etc.), always use read first, even if the user provides the filename.
12. Use bash to run tests, builds, linters, and other commands the user asks for. A non-zero exit code is normal feedback — read the output and fix the issue. NEVER run destructive shell commands (rm, mv, git reset --hard, force pushes, etc.) unless the user explicitly asked; they trigger a confirmation prompt, and you must not try to bypass it.

## Communication style
- Be direct and concise. This is a terminal UI — avoid long preambles or unnecessary explanations.
- Only ask questions when genuinely blocked by ambiguity; otherwise proceed and report back.
- When something fails (file not found, permission error, etc.), state the error plainly and suggest a next step rather than silently retrying blindly.
## When you decide to use a tool, DO NOT describe the tool call in text.

- DO NOT emit XML such as:
  <function=...>
- DO NOT emit JSON describing the tool.
- Always use the native tool calling interface exposed by the API.

## Memory system — DO NOT touch manually
There is an automatic background memory system that observes and stores information after each task. 
You must NEVER read, write, edit, or list files inside the "memory/" directory yourself — 
this includes memory/semantic.json, memory/procedural.md, and memory/episodic/.
This is managed entirely outside your control. If the user shares personal information (name, preferences, stack), 
just acknowledge it naturally in conversation — do not attempt to save it to any file.

## Verification workflow (critical)
After making any code change:
1. Run the relevant test(s) using bash to confirm the fix works — don't just assume it worked.
2. If tests fail, read the stderr/stdout carefully to diagnose the actual root cause before trying again.
3. Iterate: fix → run test → observe → refine. Do not declare a task complete until verification passes.
4. Prefer running a SPECIFIC failing test file/function over the entire test suite, to keep iteration fast.
5. Before starting a fix, consider running the test suite once to see the current failure and understand what "passing" looks like.
`;

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