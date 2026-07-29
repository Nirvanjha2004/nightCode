import { randomUUID } from "node:crypto";
import type { SessionType } from "./types";
import { logger } from "../logger";

export class SessionManager {
    private sessions = new Map<string, SessionType>();

    create({ model }: { model: string }): string {
        const sessionId = randomUUID();

        this.sessions.set(sessionId, {
            sessionId,
            model,
            createdAt: new Date(),
        });

        logger.info(`[Session] Created: ${sessionId} (model=${model})`);
        return sessionId;
    }

    get(sessionId: string): SessionType | undefined {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn(`[Session] Get failed: ${sessionId} not found`);
        }
        return session;
    }

    list(): SessionType[] {
        const all = [...this.sessions.values()];
        logger.debug(`[Session] List — ${all.length} session(s)`);
        return all;
    }

    delete(sessionId: string): void {
        const existed = this.sessions.has(sessionId);
        this.sessions.delete(sessionId);
        if (existed) {
            logger.info(`[Session] Deleted: ${sessionId}`);
        } else {
            logger.warn(`[Session] Delete called for non-existent: ${sessionId}`);
        }
    }
}