import { MessageManager } from "./agent/messages";
import { SessionManager } from "./agent/session";
import { ToolRegistry } from "./agent/registry";
import { ContextBuilder } from "./agent/context";
import { CommandRegistry } from "./agent/commands";
import { AgentHarness } from "./agent/agent-harness";
import { AgentLoop } from "./agent/loop";
import { GroqClient } from "./llm-client/groq-client";
import { TerminalUI } from "./terminal";
import type { Command } from "../components/commands-menu/types";
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
    spawnSubagent,
} from "./agent/tools";
import { EpisodicMemoryManager } from "./agent/memory/EpisodicMemoryManager";
import { SemanticMemoryManager } from "./agent/memory/SemanticMemoryManager";
import { ProceduralMemoryManager } from "./agent/memory/ProceduralMemoryManager";
import Groq from "groq-sdk";

async function main() {
    logger.info("=== NightCode Starting ===");

    // Guard env var before anything boots (Bun auto-loads .env from project root)
    const apiKey = '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';
    if (!apiKey) {
        logger.error("GROQ_API_KEY is not set — add it to .env at the project root");
        throw new Error("GROQ_API_KEY is not set in environment / .env");
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
    toolRegistry.register(spawnSubagent);

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

    // Command registry — created and loaded ONCE at startup (not per message).
    // Slash commands resolve to prompt templates + optional tool scope.
    const commandRegistry = new CommandRegistry();
    await commandRegistry.loadFromDir("commands");
    logger.info(`Command registry loaded — ${commandRegistry.list().length} command(s)`);

    // 4. Harness — bundles everything the loop needs
    logger.debug("Creating AgentHarness...");
    const harness = new AgentHarness(
        messageManager,
        sessionManager,
        toolRegistry,
        contextBuilder,
        episodicMemory,
        semanticMemory,
        proceduralMemory,
        commandRegistry
    );
    logger.info("AgentHarness created");

    // 5. LLM client
    logger.info("Initializing Groq LLM client...");
    const llm = new GroqClient(apiKey);

    // 6. Agent loop — depends on harness + llm
    logger.debug("Creating AgentLoop...");
    const agentLoop = new AgentLoop(harness, llm, 10);
    logger.info("AgentLoop created (maxIterations=10)");

    // 6.5. Hand the loop to the harness — tools like spawn_subagent call back
    //      into the SAME loop instance to run nested, isolated sub-sessions.
    harness.agentLoop = agentLoop;

    // 7. Create a session before UI starts — the model is also shown in the status bar
    const sessionModel = "qwen/qwen3.6-27b";
    let sessionId = sessionManager.create({
        model: sessionModel,
    });
    let sessionNumber = 1;
    logger.info(`Session created: ${sessionId} (#${sessionNumber})`);

    // /clear — start a FRESH conversation. Only session state is touched: the
    // old session's message history and its session record are dropped, and a
    // brand-new session is created (fresh message history + fresh context
    // summary). Files, Git state, and memory files are never touched.
    const resetSession = (): { sessionId: string; sessionNumber: number } => {
        messageManager.delete(sessionId);
        sessionManager.delete(sessionId);
        sessionId = sessionManager.create({ model: sessionModel });
        sessionNumber += 1;
        logger.info(`[Session] Reset — started fresh session: ${sessionId} (#${sessionNumber})`);
        return { sessionId, sessionNumber };
    };

    // 8. Hand off to UI — the command menu suggests the loaded slash commands
    //    (name + description) as the user types, plus the built-in UI command
    //    /clear (intercepted by the frontend; it never reaches the agent loop).
    logger.info("Starting Terminal UI...");
    const slashCommands: Command[] = [
        {
            name: "clear",
            description: "Start a fresh session (clears the conversation context)",
            value: "/clear",
        },
        ...commandRegistry.list().map((command) => ({
            name: command.name,
            description: command.description ?? command.argumentHint ?? "",
            value: `/${command.name}`,
        })),
    ];
    const ui = new TerminalUI(sessionId, agentLoop, slashCommands, sessionModel, sessionNumber, resetSession);
    await ui.start();
}

main().catch((err) => {
    logger.error(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`, {
        stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
});