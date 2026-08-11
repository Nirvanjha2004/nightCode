import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

export interface LLMClient {
    chat(
        context: ContextType,
        signal?: AbortSignal,
        /** Called with each streamed text fragment as it is generated (may be omitted for non-streaming clients). */
        onDelta?: (text: string) => void
    ): Promise<LLMResponse>;
}
