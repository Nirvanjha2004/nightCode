import type { ContextBuilder } from "./context";
import type { MessageManager } from "./messages";
import type { ToolRegistry } from "./registry";
import type { SessionManager } from "./session";
import type { Tool } from "./types";
import { logger } from "../logger";
import type { EpisodicMemoryManager } from "./memory/EpisodicMemoryManager";
import type { SemanticMemoryManager } from "./memory/SemanticMemoryManager";
import type { ProceduralMemoryManager } from "./memory/ProceduralMemoryManager";
import { extractMemories } from "./memory/memoryClassifier";

export class AgentHarness {
    constructor(
        public messageManager: MessageManager,
        public sessionManager: SessionManager,
        public toolRegistry: ToolRegistry,
        public contextBuilder: ContextBuilder,  
        public episodicMemoryManager: EpisodicMemoryManager,
        public semanticMemoryManager: SemanticMemoryManager,
        public proceduralMemoryManager: ProceduralMemoryManager,
    ) {
        logger.debug("AgentHarness constructed");
    }

    registerTool(tool: Tool): void {
        logger.info(`[Harness] Registering tool: ${tool.name}`);
        this.toolRegistry.register(tool);
    }

    createSession(model: string): string {
        logger.info(`[Harness] Creating session with model: ${model}`);
        const sessionId = this.sessionManager.create({ model });
        logger.debug(`[Harness] Session created: ${sessionId}`);
        return sessionId;
    }

    // --- NEW: memory context builder, task-execution se pehle call hoga ---
    async buildMemoryContext(userQuery: string): Promise<string> {
        logger.debug("[Harness] Building memory context");

        const facts = this.semanticMemoryManager.toPromptString();
        const rules = this.proceduralMemoryManager.toPromptString();
        const relevantEpisodes = await this.episodicMemoryManager.retrieveRelevantMemories(userQuery, 5);

        const episodesBlock = relevantEpisodes
            .map((m) => `- [${new Date(m.timestamp).toLocaleDateString()}] ${m.text}`)
            .join("\n");

        return `## Known facts\n${facts}\n\n${rules}\n\n## Relevant past events\n${episodesBlock}`;
    }

    // --- NEW: task complete hone ke baad memory extraction + persist ---
    async onTaskComplete(executionTrace: string): Promise<void> {
        logger.info("[Harness] Extracting memories from completed task");

        const extracted = await extractMemories(executionTrace); // extractor.ts se import karna hoga

        for (const fact of extracted.semantic) {
            this.semanticMemoryManager.set(fact.key, fact.value);
        }
        for (const rule of extracted.procedural) {
            this.proceduralMemoryManager.addRule(rule.rule, rule.trigger);
        }
        for (const episode of extracted.episodic) {
            await this.episodicMemoryManager.addEpisodicMemory(episode.text, episode.metadata);
        }

        logger.debug("[Harness] Memory extraction complete");
    }
}