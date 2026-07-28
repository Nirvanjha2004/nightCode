export type Tool<Targs = Record<string, string>> = {
    name : string;
    description : string;
    exec : (args : Targs) => Promise<string>;
}

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
    title : string;
    model : string;
    createdAt : Date;
    updatedAt : Date;
}

// Message types
export type MessageType = {
    messageId: string;
    sessionId: string;

    role: "system" | "user" | "assistant" | "tool";

    content: string;

    createdAt: Date;

    toolCall?: {
        id: string;
        name: string;
        args: Record<string, unknown>;
    };

    toolCallId?: string;
};

// Context types
export type ContextType = {
    sessionId : string;
    messages : MessageType[];
    model : string;
    tools : Tool<any>[];
    systemPrompt : string;
}