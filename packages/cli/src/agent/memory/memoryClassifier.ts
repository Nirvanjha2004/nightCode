import Groq from "groq-sdk";

const groq = new Groq({
    apiKey: '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',
});

export interface ExtractionResult {
    semantic: {
        key: string;
        value: unknown;
    }[];

    procedural: {
        rule: string;
        trigger?: string;
    }[];

    episodic: {
        text: string;
        metadata?: Record<string, unknown>;
    }[];
}

export async function extractMemories(
    executionTrace: string
): Promise<ExtractionResult> {
    const prompt = `You just observed an AI coding agent's completed task execution below.

Extract memory-worthy information into three categories:

1. SEMANTIC — durable facts about the user, project, or environment (stack, preferences, paths, configs). Only include facts likely to remain true long-term.

2. PROCEDURAL — reusable rules or corrections learned from this execution (e.g. "always do X before Y", "this tool needs Z"). Only include if there's a clear repeatable pattern.

3. EPISODIC — a specific noteworthy event summary (what happened, what was decided/fixed), only if it's non-trivial and could be useful to recall in a similar future situation.

Be selective — most routine tool calls (simple reads, listings, no errors) produce NOTHING in any category. Return empty arrays if nothing qualifies.

Respond ONLY with valid JSON matching this shape, no markdown, no preamble:

{
  "semantic": [{"key": "dot.path", "value": "..."}],
  "procedural": [{"rule": "...", "trigger": "optional context"}],
  "episodic": [{"text": "...", "metadata": {}}]
}

Execution trace:
${executionTrace}`;

    const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        response_format: {
            type: "json_object",
        },
        messages: [
            {
                role: "user",
                content: prompt,
            },
        ],
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
        throw new Error("Groq returned an empty response.");
    }

    try {
        return JSON.parse(content) as ExtractionResult;
    } catch (err) {
        throw new Error(
            `Failed to parse memory extraction JSON.\n\nResponse:\n${content}`
        );
    }
}


