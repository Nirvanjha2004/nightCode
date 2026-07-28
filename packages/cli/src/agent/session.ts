import type { SessionType } from "./types";

export class SessionManager {  
    private session = new Map<string, SessionType>();

    create(session: SessionType) {
        this.session.set(session.sessionId, session);
    }

    get(sessionId: string) {
        return this.session.get(sessionId);
    }

    list() {
        return [...this.session.values()];
    }
    
    delete(sessionId: string) {
        this.session.delete(sessionId);
    }
    
}