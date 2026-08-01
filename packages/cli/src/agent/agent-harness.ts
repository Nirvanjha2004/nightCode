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

import { SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "../telemetry";

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

                    const facts = await tracer.startActiveSpan(
                        "semantic.retrieve",
                        async (childSpan) => {
                            try {
                                return this.semanticMemoryManager.toPromptString();
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    const rules = await tracer.startActiveSpan(
                        "procedural.retrieve",
                        async (childSpan) => {
                            try {
                                return this.proceduralMemoryManager.toPromptString();
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    const relevantEpisodes =
                        await tracer.startActiveSpan(
                            "episodic.retrieve",
                            async (childSpan) => {
                                try {
                                    return await this.episodicMemoryManager.retrieveRelevantMemories(
                                        userQuery,
                                        5
                                    );
                                } finally {
                                    childSpan.end();
                                }
                            }
                        );

                    span.setAttribute(
                        "episodic.count",
                        relevantEpisodes.length
                    );

                    const episodesBlock = relevantEpisodes
                        .map(
                            (m) =>
                                `- [${new Date(
                                    m.timestamp
                                ).toLocaleDateString()}] ${m.text}`
                        )
                        .join("\n");

                    return `## Known facts\n${facts}\n\n${rules}\n\n## Relevant past events\n${episodesBlock}`;
                } catch (err) {
                    span.recordException(err as Error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                    });
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

                    const extracted = await tracer.startActiveSpan(
                        "memory.classify",
                        async (childSpan) => {
                            try {
                                return await extractMemories(executionTrace);
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

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
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

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
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

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
                            } finally {
                                childSpan.end();
                            }
                        }
                    );

                    logger.debug("[Harness] Memory extraction complete");
                } catch (err) {
                    span.recordException(err as Error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                    });
                    throw err;
                } finally {
                    span.end();
                }
            }
        );
    }
}
