import type { ContextType } from "../agent/types";
import type { LLMResponse } from "./types";

export interface LLMClient {
    generate(context: ContextType): Promise<LLMResponse>;
}