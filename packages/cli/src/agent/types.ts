import type { AgentHarness } from "./agent-harness";

// types.ts
export type Tool = {
    name: string;
    description: string;
    /** If true, the agent will pause and ask the user to confirm before executing this tool. */
    destructive?: boolean;
    /**
     * Dynamic destructive check — given the actual call arguments, decide whether this
     * particular invocation needs user confirmation (e.g. a bash command containing `rm -rf`).
     * Takes precedence over the static `destructive` flag when both are present.
     */
    isDestructive?: (args: Record<string, unknown>) => boolean;
    parameters: {
        type: "object";
        properties: Record<string, {
            type: string;
            description?: string;
            /** JSON-schema fields for nested shapes (e.g. array `items`), passed through to the LLM. */
            items?: Record<string, unknown>;
        }>;
        required?: string[];
    };
    /**
     * Second param is the AgentHarness, passed by the loop on every call.
     * Optional for backward compatibility with tools that don't need it
     * (and with direct calls in self-checks) — a tool that DOES need it
     * must guard against it being undefined.
     * Third param is the run's AbortSignal (same run for nested subagents);
     * child-process tools (bash, grep) use it to kill their process on cancel.
     */
    exec: (
        args: Record<string, unknown>,
        harness?: AgentHarness,
        signal?: AbortSignal
    ) => Promise<unknown>;
};

/**
 * Thrown when an agent run is cancelled via its AbortSignal. Named "AbortError"
 * (the standard name for aborted operations) so callers can detect cancellation
 * uniformly via `err.name === "AbortError"` — the same way native fetch reports
 * an aborted request. Cancellation is NOT an error: the UI renders it as
 * "⚠ Cancelled", never as an ERROR row.
 */
export class CancelledError extends Error {
    constructor(message = "Agent run cancelled.") {
        super(message);
        this.name = "AbortError";
    }
}

/**
 * A hook the UI provides to let the agent loop pause and ask the user
 * to confirm or reject a destructive action before it executes.
 * Resolves `true` if the user approved, `false` if they rejected.
 */
export type ConfirmHook = (
    message: string,
    toolName: string,
    args: Record<string, unknown>
) => Promise<boolean>;

export type ReadArgs = {
    file: string;
};

export type WriteArgs = {
    file: string;
    content: string;
};

export type AppendArgs = {
    file: string;
    content: string;
};

export type DeleteArgs = {
    file: string;
};

export type MkdirArgs = {
    dir: string;
};

export type LsArgs = {
    dir: string;
};

export type GlobArgs = {
    pattern: string;
};

export type FindArgs = {
    root: string;
    name: string;
};

export type GrepArgs = {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    maxResults?: number;
};

export type TodoItem = {
    content: string;
    status: "pending" | "in_progress" | "completed";
};

export type TodoWriteArgs = {
    todos: TodoItem[];
};

export type RenameArgs = {
    from: string;
    to: string;
};

export type CopyArgs = {
    from: string;
    to: string;
};

export type EditArgs = {
    file: string;
    oldText: string;
    newText: string;
};

// Session types
export type SessionType = {
    sessionId : string;
    model : string;
    /** Provider id this session's model belongs to (informational). */
    provider?: string;
    createdAt : Date;
    updatedAt?: Date;
}
export type ToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>; // unknown > string, args can be numbers/booleans/nested too
};

/**
 * UI-facing progress events streamed from AgentLoop to the terminal via
 * ExecuteOptions.onEvent. Display-only — never stored in message history.
 */
export type AgentEvent =
    | { type: "stage"; name: string }
    | { type: "iteration"; n: number; max: number }
    | { type: "tool_start"; toolName: string; argsPreview: string }
    | { type: "tool_end"; toolName: string; ok: boolean; durationMs: number; resultPreview: string }
    /** A slice of the assistant's reply as it streams (Pi-style live rendering). */
    | { type: "text_delta"; text: string }
    | { type: "cancelled" };

// Message types
export type MessageType = {
    messageId: string;
    sessionId: string;

    role: "system" | "user" | "assistant" | "tool";

    content: string;

    createdAt: Date;

    toolCalls?: ToolCall[];

    toolCallId?: string;
};

// Context types

/**
 * Neutral tool definition (OpenAI-compatible wire shape). The agent builds
 * these; provider adapters convert them to their own tool formats.
 */
export type ToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
};

export type ContextType = {
    sessionId: string;
    model: string;
    systemPrompt: string;
    messages: MessageType[];
    tools: ToolDefinition[];
    /** Ask the provider for a structured-JSON response (openai-compatible). */
    jsonMode?: boolean;
    /** Normalized reasoning effort for this call (off|low|medium|high|max). */
    reasoningEffort?: string;
};