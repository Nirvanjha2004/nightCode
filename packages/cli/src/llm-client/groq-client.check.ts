// groq-client.check.ts — assert-based self-check for Groq error-code extraction.
// Regression: the SDK nests the API body as `err.error = { error: { code, ... } }`,
// so `err.error.code` was undefined and the `tool_use_failed` repair retry never
// fired — the raw 400 crashed the whole turn. This check locks in the nested lookup.
// Run with: bun packages/cli/src/llm-client/groq-client.check.ts
import assert from "node:assert/strict";
import { getGroqErrorCode } from "./groq-client";

// 1. Real SDK shape (BadRequestError): err.error is the WHOLE body, so the
//    code lives one level deeper at err.error.error.code.
const sdkShape = {
    error: {
        error: {
            message: "Failed to call a function...",
            type: "invalid_request_error",
            code: "tool_use_failed",
            failed_generation: "<tool_call>\n<function=spawn_subagent>",
        },
    },
};
assert.equal(
    getGroqErrorCode(sdkShape),
    "tool_use_failed",
    "nested SDK error body (err.error.error.code) must be detected"
);

// 2. Flat fallbacks for other SDK shapes/versions.
assert.equal(
    getGroqErrorCode({ error: { code: "rate_limit_exceeded" } }),
    "rate_limit_exceeded",
    "flat err.error.code fallback"
);
assert.equal(
    getGroqErrorCode({ code: "internal_error" }),
    "internal_error",
    "bare err.code fallback"
);

// 3. Unrecognized errors → undefined (caller logs + rethrows).
assert.equal(getGroqErrorCode({}), undefined, "no code → undefined");
assert.equal(getGroqErrorCode(null), undefined, "null → undefined");
assert.equal(getGroqErrorCode(undefined), undefined, "undefined → undefined");
assert.equal(getGroqErrorCode("boom"), undefined, "non-object → undefined");

// 4. failed_generation is reachable at err.error.error.failed_generation —
//    this is the field the repair retry replays back to the model.
const e = sdkShape.error as { error?: { failed_generation?: string } };
assert.ok(
    e.error?.failed_generation?.includes("<function=spawn_subagent>"),
    "failed_generation readable at err.error.error.failed_generation"
);

console.log("PASS — Groq error-code extraction handles the nested SDK shape.");
