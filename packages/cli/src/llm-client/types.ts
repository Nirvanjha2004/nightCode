import type { ToolCall } from "../agent/types";

export type LLMResponse =
    | {
          type: "text";
          content: string;
      }
    | {
          type: "tool_calls";
          toolCalls: ToolCall[];
      };