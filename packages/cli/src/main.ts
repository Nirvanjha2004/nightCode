import { MessageManager } from "./agent/messages";
import { SessionManager } from "./agent/session";
import { ToolRegistry } from "./agent/registry";
import { ContextBuilder } from "./agent/context";
import { CommandRegistry } from "./agent/commands";
import { AgentHarness } from "./agent/agent-harness";
import { AgentLoop } from "./agent/loop";
import { TerminalUI } from "./ui/terminal";
import type { Command } from "./ui/commands-menu/types";
import { logger } from "./logger";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths";

//// Tools — all 15
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
import { loadConfig, buildProviderSystem } from "./llm-client";
import type { ModelMenuData } from "./ui/model-menu/types";

/** Friendly startup error listing how to configure credentials. */
function bootError(providerId: string, hint: string): string {
    return [
        `NightCode could not start: provider "${providerId}" has no API key configured.`,
        ``,
        `Fix one of:`,
        `  1. ${hint}`,
        `  2. Choose a different provider in nightcode.config.json or via NIGHTCODE_PROVIDER:`,
        `       { "provider": "openai", "model": "gpt-4o" }`,
        `  3. Local models need no key — try NIGHTCODE_PROVIDER=ollama (http://localhost:11434).`,
        `  4. Set one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY,`,
        `     MISTRAL_API_KEY, XAI_API_KEY, ... in .env at the project root.`,
        ``,
        `See docs/providers.md for the full list of supported providers.`,
    ].join("\n");
}

async function main() {
    logger.info("=== NightCode Starting ===");

    // 0. Provider system — config file + env → registry + active-provider router.
    const config = loadConfig();
    const system = buildProviderSystem(config);
    const { registry, router, status } = system;

    const activeStatus = status[router.providerId];
    if (!activeStatus?.ok) {
        logger.error(`Provider "${router.providerId}" is not authenticated (${activeStatus?.hint ?? "unknown reason"})`);
        throw new Error(bootError(router.providerId, activeStatus?.hint ?? "set the provider's API key"));
    }
    logger.info(`Active provider: ${router.providerId} (${router.activeProvider.displayName})`);

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

    // 3. ContextBuilder — the router powers context summarization
    logger.debug("Building ContextBuilder...");
    const contextBuilder = new ContextBuilder(
        messageManager,
        sessionManager,
        toolRegistry,
        router
    );
    logger.info("ContextBuilder created");

    // Command registry — created and loaded ONCE at startup (not per message).
    const commandRegistry = new CommandRegistry();
    await commandRegistry.loadFromDir(join(PROJECT_ROOT, "commands"));
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
        commandRegistry,
        router
    );
    logger.info("AgentHarness created");

    // 5. LLM — the provider router (the loop stays provider-agnostic)
    const llm = router;

    // 6. Agent loop
    logger.debug("Creating AgentLoop...");
    const agentLoop = new AgentLoop(harness, llm, 10);
    logger.info("AgentLoop created (maxIterations=10)");

    // 6.5. Hand the loop to the harness — tools like spawn_subagent call back
    //      into the SAME loop instance to run nested, isolated sub-sessions.
    harness.agentLoop = agentLoop;

    // 7. Create a session before UI starts — the model is also shown in the status bar
    let currentProviderId = router.providerId;
    let currentModel = config.model;
    {
        const known = router.listModels().some((m) => m.id === config.model);
        if (!known) {
            const fallback = router.listModels()[0];
            if (fallback) {
                logger.warn(
                    `[Model] "${config.model}" is not in the "${currentProviderId}" catalog — using "${fallback.id}" (add it via nightcode.config.json to keep it)`
                );
                currentModel = fallback.id;
            }
            // no fallback → keep the configured model id; adapters tolerate unknown ids
        }
    }
    let sessionId = sessionManager.create({
        model: currentModel,
        provider: currentProviderId,
    });
    let sessionNumber = 1;
    logger.info(`Session created: ${sessionId} (#${sessionNumber}) — ${currentProviderId}/${currentModel}`);

    // /clear — start a FRESH conversation. Only session state is touched.
    const resetSession = (): { sessionId: string; sessionNumber: number } => {
        messageManager.delete(sessionId);
        sessionManager.delete(sessionId);
        sessionId = sessionManager.create({
            model: currentModel,
            provider: currentProviderId,
        });
        sessionNumber += 1;
        logger.info(`[Session] Reset — started fresh session: ${sessionId} (#${sessionNumber})`);
        return { sessionId, sessionNumber };
    };

    // 7.5. Model switching — updates the router (active provider), the session
    //      record, and the UI label. The next turn uses the new provider/model.
    const switchModel = (providerId: string, modelId: string): { providerId: string; modelId: string } => {
        router.setActiveProvider(providerId);
        currentProviderId = providerId;
        currentModel = modelId;
        sessionManager.update(sessionId, { model: modelId, provider: providerId });
        logger.info(`[Model] Switched to ${providerId}/${modelId}`);
        return { providerId, modelId };
    };

    const getModelOptions = (): ModelMenuData => ({
        providers: registry.list().map((p) => ({
            id: p.providerId,
            displayName: p.displayName,
            authOk: status[p.providerId]?.ok ?? false,
            models: p.listModels().map((m) => ({
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                reasoning: m.reasoning,
                vision: m.vision,
            })),
        })),
    });

    // 8. Hand off to UI
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
    const ui = new TerminalUI(
        sessionId,
        agentLoop,
        slashCommands,
        {
            model: currentModel,
            providerId: currentProviderId,
            getModelOptions,
            onSwitchModel: switchModel,
        },
        sessionNumber,
        resetSession
    );
    await ui.start();
}

main().catch((err) => {
    logger.error(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`, {
        stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
});
