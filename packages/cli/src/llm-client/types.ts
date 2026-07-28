export type LLMResponse =
    | {
          type: "text";
          content: string;
      }
    | {
          type: "tool_call";
          toolCall: {
              name: string;
              args: Record<string, unknown>;
          };
      };