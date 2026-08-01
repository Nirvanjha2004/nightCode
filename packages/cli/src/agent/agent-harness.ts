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

import { markSpanError, tracer } from "../telemetry";

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

    async buildMemoryContext(userQuery: string): Promise<string> {
        return tracer.startActiveSpan(
            "build_memory_context",
            async (span) => {
                try {
                    logger.debug("[Harness] Building memory context");

                    span.setAttribute("query.length", userQuery.length);

                    span.addEvent("Loading semantic memories");
                    const facts = await tracer.startActiveSpan(
                        "semantic.retrieve",
                        async (childSpan) => {
                            try {
                                return this.semanticMemoryManager.toPromptString();
                            } catch (err) {
                                markSpanError(childSpan, err);
                                throw err;
                            } finally {
                                childSpan.end();
                            }
                        }
                    );
                    const semanticCount = facts
                        .split("\n")
                        .filter((l) => l.trim().length > 0).length;

                    span.addEvent("Loading procedural memories");
                    const rules = await tracer.startActiveSpan(
                        "procedural.retrieve",
                        async (childSpan) => {
                            try {
                                return this.proceduralMemoryManager.toPromptString();
                            } catch (err) {
                                markSpanError(childSpan, err);
                                throw err;
                            } finally {
                                childSpan.end();
                            }
                        }
                    );
                    // Exact rule count — line-splitting toPromptString() would count
                    // its "## Learned rules" header as a fake rule.
                    const proceduralCount = this.proceduralMemoryManager.size;

                    span.addEvent("Searching episodic memories");
                    const relevantEpisodes =
                        await tracer.startActiveSpan(
                            "episodic.retrieve",
                            async (childSpan) => {
                                try {
                                    return await this.episodicMemoryManager.retrieveRelevantMemories(
                                        userQuery,
                                        5
                                    );
                                } catch (err) {
                                    markSpanError(childSpan, err);
                                    throw err;
                                } finally {
                                    childSpan.end();
                                }
                            }
                        );

                    const episodicCount = relevantEpisodes.length;
                    span.setAttribute("memory.semantic.count", semanticCount);
                    span.setAttribute("memory.procedural.count", proceduralCount);
                    span.setAttribute("memory.episodic.count", episodicCount);
                    span.setAttribute(
                        "memory.total",
                        semanticCount + proceduralCount + episodicCount
                    );

                    const episodesBlock = relevantEpisodes
                        .map(
                            (m) =>
                                `- [${new Date(
                                    m.timestamp
                                ).toLocaleDateString()}] ${m.text}`
                        )
                        .join("\n");

                    const result = `## Known facts\n${facts}\n\n${rules}\n\n## Relevant past events\n${episodesBlock}`;
                    span.setAttribute("memory.context.length", result.length);
                    span.addEvent("Memory context constructed");
                    return result;
                } catch (err) {
                    markSpanError(span, err);
                    throw err;
                } finally {
                    span.end();
                }
            }
        );
    }

    async onTaskComplete(executionTrace: string): Promise<void> {
        await tracer.startActiveSpan(
            "memory.extract",
            async (span) => {
                try {
                    logger.info(
                        "[Harness] Extracting memories from completed task"
                    );

                    span.setAttribute(
                        "trace.length",
                        executionTrace.length
                    );
                    span.addEvent("Extracting memories");

                    const extracted = await tracer.startActiveSpan(
                        "memory.classify",
                        async (childSpan) => {
                            try {
                                return await extractMemories(executionTrace);
                            } catch (err) {
                                markSpanError(childSpan, err);
                                throw err;
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    span.setAttribute("memory.semantic.extracted", extracted.semantic.length);
                    span.setAttribute("memory.procedural.extracted", extracted.procedural.length);
                    span.setAttribute("memory.episodic.extracted", extracted.episodic.length);

                    span.addEvent("Persisting semantic memory");
                    await tracer.startActiveSpan(
                        "semantic.store",
                        async (childSpan) => {
                            try {
                                for (const fact of extracted.semantic) {
                                    this.semanticMemoryManager.set(
                                        fact.key,
                                        fact.value
                                    );
                                }

                                childSpan.setAttribute(
                                    "semantic.count",
                                    extracted.semantic.length
                                );
                            } catch (err) {
                                markSpanError(childSpan, err);
                                throw err;
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    span.addEvent("Persisting procedural memory");
                    await tracer.startActiveSpan(
                        "procedural.store",
                        async (childSpan) => {
                            try {
                                for (const rule of extracted.procedural) {
                                    this.proceduralMemoryManager.addRule(
                                        rule.rule,
                                        rule.trigger
                                    );
                                }

                                childSpan.setAttribute(
                                    "procedural.count",
                                    extracted.procedural.length
                                );
                            } catch (err) {
                                markSpanError(childSpan, err);
                                throw err;
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    span.addEvent("Persisting episodic memory");
                    await tracer.startActiveSpan(
                        "episodic.store",
                        async (childSpan) => {
                            try {
                                for (const episode of extracted.episodic) {
                                    await this.episodicMemoryManager.addEpisodicMemory(
                                        episode.text,
                                        episode.metadata
                                    );
                                }

                                childSpan.setAttribute(
                                    "episodic.count",
                                    extracted.episodic.length
                                );
                            } catch (err) {
                                markSpanError(childSpan, err);
                                throw err;
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    span.addEvent("Memory extraction completed");
                    logger.debug("[Harness] Memory extraction complete");
                } catch (err) {
                    markSpanError(span, err);
                    throw err;
                } finally {
                    span.end();
                }
            }
        );
    }
}
