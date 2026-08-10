import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

export interface LLMClient {
    chat(context: ContextType, signal?: AbortSignal): Promise<LLMResponse>;
}