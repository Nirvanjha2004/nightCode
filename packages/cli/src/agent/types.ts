import type Groq from "groq-sdk";

// types.ts
export type Tool = {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, {
            type: string;
            description?: string;
        }>;
        required?: string[];
    };
    exec: (args: Record<string, unknown>) => Promise<unknown>;
};

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