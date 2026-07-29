import { useState, useCallback } from "react";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar"; 
import type { AgentLoop } from "../src/agent/loop";
import { logger } from "./logger";

// Display-only — agent context lives in backend MessageManager, not here
type DisplayMessage = {
    id: string;
    role: "user" | "assistant" | "error";
    content: string;
};

type Props = {
    sessionId: string;
    agentLoop: AgentLoop;
};

export function App({ sessionId, agentLoop }: Props) {
    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [loading, setLoading]   = useState(false);

    const push = (role: DisplayMessage["role"], content: string) => {
        setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role, content },
        ]);
    };

    const handleSubmit = useCallback(async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || loading) return;

        logger.info(`[UI] User submitted: "${trimmed.slice(0, 100)}"`);
        push("user", trimmed);
        setLoading(true);

        try {
            const response = await agentLoop.execute(sessionId, trimmed);
            logger.info(`[UI] Agent response received (len=${response.length})`);
            push("assistant", response);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[UI] Agent execution failed: ${errMsg}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
            push("error", errMsg);
        } finally {
            setLoading(false);
        }
    }, [loading, sessionId, agentLoop]);

    return (
        <box
            flexDirection="column"
            backgroundColor="#0D0D12"
            width="100%"
            height="100%"
            gap={2}
        >
            <Header />

            {/* Display-only message list */}
            <box
                flexGrow={1}
                flexDirection="column"
                paddingX={2}
                overflow="scroll"
            >
                {messages.length === 0 && !loading && (
                    <text fg="#3A3A4A">No messages yet. Start typing below.</text>
                )}

                {messages.map((msg) => (
                    <box key={msg.id} flexDirection="column" marginBottom={1}>
                        <text
                            fg={
                                msg.role === "user"      ? "#89B4FA" :
                                msg.role === "assistant" ? "#A6E3A1" : "#F38BA8"
                            }
                        >
                            {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "Error"}
                        </text>
                        <text fg="#CDD6F4">{msg.content}</text>
                    </box>
                ))}

                {loading && (
                    <text fg="#F9E2AF">Agent is thinking...</text>
                )}
            </box>

            <InputBar onSubmit={handleSubmit} disabled={loading} />
        </box>
    );
}