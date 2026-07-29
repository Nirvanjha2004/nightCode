import type { MessageType } from "./types";
import { logger } from "../logger";

export class MessageManager {
    private messages = new Map<string, MessageType[]>();

    add(message: MessageType) {
        const history = this.messages.get(message.sessionId) ?? [];
        history.push(message);
        this.messages.set(message.sessionId, history);

        logger.debug(`[Messages] Added ${message.role} message — session=${message.sessionId}, historyLen=${history.length}`);
    }

    get(sessionId: string) {
        const msgs = this.messages.get(sessionId) ?? [];
        logger.debug(`[Messages] Get session=${sessionId} — returning ${msgs.length} messages`);
        return msgs;
    }

    delete(sessionId: string) {
        const existed = this.messages.has(sessionId);
        this.messages.delete(sessionId);
        if (existed) {
            logger.debug(`[Messages] Deleted session=${sessionId}`);
        }
    }

    clear() {
        const count = this.messages.size;
        this.messages.clear();
        logger.debug(`[Messages] Cleared all messages (${count} sessions)`);
    }
}