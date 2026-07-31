import type Groq from "groq-sdk";

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
    exec: (args: Record<string, unknown>) => Promise<unknown>;
};

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
    createdAt : Date;
    updatedAt?: Date;
}
export type ToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>; // unknown > string, args can be numbers/booleans/nested too
};

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
export type ContextType = {
    sessionId: string;
    model: string;
    systemPrompt: string;
    messages: MessageType[];
    tools: Groq.Chat.Completions.ChatCompletionTool[];
};