import type { MessageType } from "./types";

export class MessageManager {
    private messages = new Map<string, MessageType[]>();

    add(message: MessageType) {
        const history = this.messages.get(message.sessionId) ?? [];

        history.push(message);

        this.messages.set(message.sessionId, history);
    }

    get(sessionId: string) {
        return this.messages.get(sessionId) ?? [];
    }

    delete(sessionId: string) {
        this.messages.delete(sessionId);
    }

    clear() {
        this.messages.clear();
    }
}