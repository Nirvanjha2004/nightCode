// errors.check.ts — assert-based self-check for provider error normalization.
// Verifies: HTTP status → normalized error type mapping, retryable flags,
// safe messages (no raw bodies), Retry-After parsing, and that withRetry
// retries only retryable errors and never retries aborts.
// Run with: bun packages/cli/src/llm-client/errors.check.ts
import assert from "node:assert/strict";
import {
    AuthenticationError,
    ContextLengthError,
    InvalidRequestError,
    ModelNotFoundError,
    ProviderUnavailableError,
    RateLimitError,
    ToolCallingError,
    classifyHttpError,
    extractErrorCode,
    parseRetryAfter,
    withRetry,
} from "./errors";
import { CancelledError } from "../agent/types";

async function main() {
    // ── HTTP status → error type ──────────────────────────────────────
    assert.ok(classifyHttpError({ status: 401, provider: "openai" }) instanceof AuthenticationError, "401 → AuthenticationError");
    assert.ok(classifyHttpError({ status: 403, provider: "openai" }) instanceof AuthenticationError, "403 → AuthenticationError");
    assert.ok(classifyHttpError({ status: 429, provider: "groq" }) instanceof RateLimitError, "429 → RateLimitError");
    assert.ok(classifyHttpError({ status: 500, provider: "groq" }) instanceof ProviderUnavailableError, "500 → ProviderUnavailableError");
    assert.ok(classifyHttpError({ status: 400, provider: "x" }) instanceof InvalidRequestError, "plain 400 → InvalidRequestError");
    assert.ok(classifyHttpError({ status: 404, provider: "x" }) instanceof ModelNotFoundError, "404 → ModelNotFoundError");

    // ── body hints ────────────────────────────────────────────────────
    const ctxErr = classifyHttpError({
        status: 400,
        body: JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens" } }),
    });
    assert.ok(ctxErr instanceof ContextLengthError, "context-length message → ContextLengthError");

    const modelErr = classifyHttpError({
        status: 400,
        body: JSON.stringify({ error: { message: "The model `llama-3.3-70b-versatile` does not exist" } }),
    });
    assert.ok(modelErr instanceof ModelNotFoundError, "model-not-found message → ModelNotFoundError");

    const toolErr = classifyHttpError({
        status: 400,
        body: JSON.stringify({ error: { code: "tool_use_failed", message: "invalid tool call" } }),
    });
    assert.ok(toolErr instanceof ToolCallingError, "tool_use_failed code → ToolCallingError");

    // ── fields: provider/model/status/retryable/message ───────────────
    const rate = classifyHttpError({ status: 429, provider: "groq", model: "m", body: "rate limited" });
    assert.equal(rate.provider, "groq");
    assert.equal(rate.model, "m");
    assert.equal(rate.status, 429);
    assert.equal(rate.retryable, true, "rate limits are retryable");
    assert.equal(rate.message, "HTTP 429", "non-JSON bodies fall back to a safe status-only message");
    assert.ok(!(classifyHttpError({ status: 401 }) instanceof RateLimitError), "auth failures are never retryable");
    assert.equal(classifyHttpError({ status: 401 }).retryable, false, "auth never retried");
    assert.equal(classifyHttpError({ status: 400 }).retryable, false, "invalid request never retried");

    // ── Retry-After parsing ───────────────────────────────────────────
    assert.equal(parseRetryAfter("5"), 5000, "seconds → ms");
    assert.equal(parseRetryAfter(null), undefined, "null → undefined");
    assert.ok((parseRetryAfter("999999") ?? 0) <= 60_000, "Retry-After is capped");

    // ── error-code extraction (Groq/SDK nested shapes) ────────────────
    assert.equal(extractErrorCode({ error: { error: { code: "rate_limit_exceeded" } } }), "rate_limit_exceeded");
    assert.equal(extractErrorCode({ error: { code: "internal_error" } }), "internal_error");
    assert.equal(extractErrorCode({ code: "boom" }), "boom");
    assert.equal(extractErrorCode({}), undefined);
    assert.equal(extractErrorCode(null), undefined);
    assert.equal(extractErrorCode("nope"), undefined);

    // ── withRetry policy ──────────────────────────────────────────────
    let attempts = 0;
    const result = await withRetry(
        async () => {
            attempts++;
            if (attempts < 3) {
                throw new RateLimitError({ message: "slow down", retryAfterMs: 1 });
            }
            return "ok";
        },
        { maxRetries: 3, baseDelayMs: 1 },
        undefined
    );
    assert.equal(result, "ok", "retryable error retries until success");
    assert.equal(attempts, 3, "retried exactly the needed number of times");

    // non-retryable errors are not retried
    let calls = 0;
    await assert.rejects(
        withRetry(
            async () => {
                calls++;
                throw new AuthenticationError({ message: "bad key" });
            },
            { maxRetries: 5, baseDelayMs: 1 },
            undefined
        ),
        AuthenticationError
    );
    assert.equal(calls, 1, "auth errors are never retried");

    // aborts are never retried
    let abortCalls = 0;
    const ctrl = new AbortController();
    const p = withRetry(
        async (signal) => {
            abortCalls++;
            signal?.throwIfAborted?.();
            throw new ProviderUnavailableError({ message: "down", retryable: true });
        },
        { maxRetries: 5, baseDelayMs: 1 },
        ctrl.signal
    );
    ctrl.abort();
    await assert.rejects(p, ProviderUnavailableError);
    assert.equal(abortCalls, 1, "aborted attempt is not retried");

    // retryAfter hint is honored as the first delay (a short sleep proves it)
    const delays: number[] = [];
    const hintResult = await withRetry(
        async () => {
            if (delays.length === 0) throw new RateLimitError({ message: "rl", retryAfterMs: 5 });
            return "done";
        },
        {
            maxRetries: 1,
            onRetry: (_e, _a, d) => delays.push(d),
        },
        undefined
    );
    assert.equal(hintResult, "done");
    assert.ok(delays[0]! >= 3 && delays[0]! <= 60_000, "Retry-After hint used for the delay (jittered ±25%)");

    console.log("PASS — provider errors normalize, classify, and retry correctly.");
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
