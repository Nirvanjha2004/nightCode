import { MessageManager } from "./agent/messages";
import { SessionManager } from "./agent/session";
import { ToolRegistry } from "./agent/registry";
import { ContextBuilder } from "./agent/context";
import { AgentHarness } from "./agent/agent-harness";
import { AgentLoop } from "./agent/loop";
import { GroqClient } from "./llm-client/groq-client";
import { TerminalUI } from "./terminal";
import { logger } from "./logger";

//// Tools — all 14, not just 3
import {
    read,
    write,
    append,
    edit,
    del,
    makeDir,
    ls,
    globTool,
    find,
    grep,
    renameTool,
    copy,
    bash,
    todoWrite,
} from "./agent/tools";
import { EpisodicMemoryManager } from "./agent/memory/EpisodicMemoryManager";
import { SemanticMemoryManager } from "./agent/memory/SemanticMemoryManager";
import { ProceduralMemoryManager } from "./agent/memory/ProceduralMemoryManager";
import Groq from "groq-sdk";

async function main() {
    logger.info("=== NightCode Starting ===");

    // Guard env var before anything boots
    const apiKey = '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';
    if (!apiKey) {
        logger.error("GROQ_API_KEY is not set in environment");
        throw new Error("GROQ_API_KEY is not set in environment");
    }

    // 1. Managers — no dependencies, boot first
    logger.debug("Initializing managers...");
    const messageManager = new MessageManager();
    const sessionManager = new SessionManager();
    const toolRegistry   = new ToolRegistry();
    const episodicMemory = new EpisodicMemoryManager();
    const semanticMemory = new SemanticMemoryManager();
    const proceduralMemory = new ProceduralMemoryManager();
    logger.info("Managers initialized (MessageManager, SessionManager, ToolRegistry, EpisodicMemory, SemanticMemory, ProceduralMemory)");

    // 2. Register ALL tools into registry
    logger.debug("Registering built-in tools...");
    toolRegistry.register(read);
    toolRegistry.register(write);
    toolRegistry.register(append);
    toolRegistry.register(edit);
    toolRegistry.register(del);
    toolRegistry.register(makeDir);
    toolRegistry.register(ls);
    toolRegistry.register(globTool);
    toolRegistry.register(find);
    toolRegistry.register(grep);
    toolRegistry.register(renameTool);
    toolRegistry.register(copy);
    toolRegistry.register(bash);
    toolRegistry.register(todoWrite);

    const registeredNames = toolRegistry.list().map((t) => t.name);
    logger.info(`Built-in tools registered (${registeredNames.length}): ${registeredNames.join(", ")}`);

    // 3. ContextBuilder — depends on all three managers
    logger.debug("Building ContextBuilder...");
    const contextBuilder = new ContextBuilder(
        messageManager,
        sessionManager,
        toolRegistry,
        new Groq({
            apiKey,
        })
    );
    logger.info("ContextBuilder created");

    // 4. Harness — bundles everything the loop needs
    logger.debug("Creating AgentHarness...");
    const harness = new AgentHarness(
        messageManager,
        sessionManager,
        toolRegistry,
        contextBuilder,
        episodicMemory,
        semanticMemory,
        proceduralMemory
    );
    logger.info("AgentHarness created");

    // 5. LLM client
    logger.info("Initializing Groq LLM client...");
    const llm = new GroqClient(apiKey);

    // 6. Agent loop — depends on harness + llm
    logger.debug("Creating AgentLoop...");
    const agentLoop = new AgentLoop(harness, llm, 10);
    logger.info("AgentLoop created (maxIterations=10)");

    // 7. Create a session before UI starts
    const sessionId = sessionManager.create({
        model: "qwen/qwen3.6-27b",
    });
    logger.info(`Session created: ${sessionId}`);

    // 8. Hand off to UI
    logger.info("Starting Terminal UI...");
    const ui = new TerminalUI(sessionId, agentLoop);
    await ui.start();
}

main().catch((err) => {
    logger.error(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`, {
        stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
});