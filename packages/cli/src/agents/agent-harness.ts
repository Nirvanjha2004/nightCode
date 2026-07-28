import { ContextBuilder } from "./context";
import { MessageManager } from "./messages";
import { ToolRegistry } from "./registry";
import { AgentLoop } from "./loop";
import { SessionManager } from "./session";

export class AgentHarness {
    public sessionManager: SessionManager;
    public messageManager: MessageManager;
    public contextBuilder: ContextBuilder;
    public toolRegistry: ToolRegistry;
    private loop: AgentLoop;

    constructor(private llm: any) {
        this.sessionManager = new SessionManager();
        this.messageManager = new MessageManager();
        this.toolRegistry = new ToolRegistry();
        this.contextBuilder = new ContextBuilder(this.messageManager,  this.sessionManager, this.toolRegistry);
        
        // Loop me harness pass kar rahe hain
        this.loop = new AgentLoop(this, this.llm);
    }

    // High-level entrypoint for the application
    async run(sessionId: string, userInput: string): Promise<string> {
        return await this.loop.execute(sessionId, userInput);
    }
}