// llm-client/errors.ts — normalized provider errors + retry policy.
//
// Every adapter converts provider-specific failures into one of these types.
// Fields: provider, model, HTTP status, retryable, retryAfter, and a SAFE
// message — never raw bodies that might contain secrets.

export type ProviderErrorOptions = {
    kind: string;
    message: string;
    provider?: string;
    model?: string;
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    cause?: unknown;
};

/** Base class for all normalized provider errors. */
export class ProviderError extends Error {
    readonly kind: string;
    readonly provider?: string;
    readonly model?: string;
    readonly status?: number;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;

    constructor(opts: ProviderErrorOptions) {
        // `cause` is threaded through Error's own options (ES2022) so the
        // original error stays reachable without redeclaring the field.
        super(opts.message, { cause: opts.cause });
        this.name = "ProviderError";
        this.kind = opts.kind;
        this.provider = opts.provider;
        this.model = opts.model;
        this.status = opts.status;
        this.retryable = opts.retryable ?? false;
        this.retryAfterMs = opts.retryAfterMs;
    }
}

type ErrorOpts = Omit<ProviderErrorOptions, "kind">;

export class AuthenticationError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "AuthenticationError", retryable: false });
        this.name = "AuthenticationError";
    }
}

export class RateLimitError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "RateLimitError", retryable: true });
        this.name = "RateLimitError";
    }
}

export class InvalidRequestError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "InvalidRequestError", retryable: false });
        this.name = "InvalidRequestError";
    }
}

export class ModelNotFoundError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "ModelNotFoundError", retryable: false });
        this.name = "ModelNotFoundError";
    }
}

export class ContextLengthError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "ContextLengthError", retryable: false });
        this.name = "ContextLengthError";
    }
}

export class ProviderUnavailableError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "ProviderUnavailableError", retryable: true });
        this.name = "ProviderUnavailableError";
    }
}

export class TimeoutError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "TimeoutError", retryable: true });
        this.name = "TimeoutError";
    }
}

export class ToolCallingError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "ToolCallingError", retryable: false });
        this.name = "ToolCallingError";
    }
}

export class UnknownProviderError extends ProviderError {
    constructor(opts: ErrorOpts) {
        super({ ...opts, kind: "UnknownProviderError", retryable: false });
        this.name = "UnknownProviderError";
    }
}

/** Error code extraction for OpenAI-compatible SDK-ish error objects. */
export function extractErrorCode(err: unknown): string | undefined {
    const e = err as {
        error?: { error?: { code?: string }; code?: string };
        code?: string;
    };
    return e?.error?.error?.code ?? e?.error?.code ?? e?.code;
}

/** Safe message from an unknown error — never includes raw bodies/headers. */
export function safeErrorMessage(err: unknown): string {
    if (err instanceof ProviderError) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
}

const CONTEXT_HINTS = /context|token|prompt.*(long|exceed|limit|length)|too long/i;
const MODEL_HINTS = /model.*(not found|does not exist|no such|unknown)|invalid.*model/i;

/**
 * Classify an HTTP failure into a normalized ProviderError. The message is
 * built from the (JSON) error body when present, capped and sanitized — raw
 * bodies are never surfaced verbatim.
 */
export function classifyHttpError(opts: {
    status: number;
    body?: string;
    provider?: string;
    model?: string;
    retryAfterMs?: number;
}): ProviderError {
    const { status, provider, model, retryAfterMs } = opts;
    let apiMessage = "";
    let apiCode = "";
    try {
        const parsed = opts.body ? JSON.parse(opts.body) : null;
        const err = parsed?.error ?? parsed;
        if (typeof err?.message === "string") apiMessage = err.message;
        if (typeof err?.code === "string") apiCode = err.code;
    } catch {
        // non-JSON body — fall through to status-only message
    }
    const detail = apiMessage.slice(0, 300) || `HTTP ${status}`;
    const base = { provider, model, status, retryAfterMs, message: detail };

    if (status === 401 || status === 403) {
        return new AuthenticationError(base);
    }
    if (status === 429) {
        return new RateLimitError(base);
    }
    if (status === 404 || apiCode === "model_not_found" || MODEL_HINTS.test(detail)) {
        return new ModelNotFoundError(base);
    }
    if (status === 413 || apiCode === "context_length_exceeded" || CONTEXT_HINTS.test(detail)) {
        return new ContextLengthError(base);
    }
    if (status >= 500) {
        return new ProviderUnavailableError(base);
    }
    if (status === 400 && apiCode === "tool_use_failed") {
        return new ToolCallingError(base);
    }
    return new InvalidRequestError(base);
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date) into ms. */
export function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
        const ms = date - Date.now();
        return ms > 0 ? Math.min(ms, 60_000) : 1000;
    }
    return undefined;
}

export type RetryOptions = {
    maxRetries?: number;
    /** Base delay between retries; doubled each attempt (with jitter). */
    baseDelayMs?: number;
    /** Cap on a single backoff delay. */
    maxDelayMs?: number;
    /** Which errors are worth retrying (defaults to err.retryable). */
    shouldRetry?: (err: unknown) => boolean;
    /** Optional logging hook. */
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelay(err: unknown, attempt: number, opts: RetryOptions): number {
    const hint = err instanceof ProviderError ? err.retryAfterMs : undefined;
    // jitter: ±25% so a fleet of retries doesn't stampede
    const jitter = 0.75 + Math.random() * 0.5;
    const base = opts.baseDelayMs ?? 400;
    const cap = opts.maxDelayMs ?? 8000;
    return Math.min(hint ?? base * 2 ** attempt * jitter, cap);
}

/**
 * Retry wrapper for promise-returning calls. Only retryable errors are
 * retried; aborts and auth/invalid-request failures never retry. Honors a
 * retryAfterMs hint (e.g. Retry-After) with exponential backoff otherwise.
 */
export async function withRetry<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    opts: RetryOptions = {},
    signal?: AbortSignal
): Promise<T> {
    const maxRetries = opts.maxRetries ?? 2;
    let attempt = 0;
    for (;;) {
        try {
            return await fn(signal);
        } catch (err) {
            const retryable =
                err instanceof ProviderError
                    ? err.retryable
                    : (opts.shouldRetry?.(err) ?? false);
            if (attempt >= maxRetries || !retryable || signal?.aborted) throw err;
            const delay = retryDelay(err, attempt, opts);
            opts.onRetry?.(err, attempt + 1, delay);
            await sleep(delay);
            attempt++;
        }
    }
}

/**
 * Retry wrapper for streaming: restarts the WHOLE stream (a fresh request)
 * when a retryable error surfaces mid-stream. Aborts never retry.
 */
export async function* withRetryStream<T>(
    factory: (signal?: AbortSignal) => AsyncGenerator<T>,
    opts: RetryOptions = {},
    signal?: AbortSignal
): AsyncGenerator<T> {
    const maxRetries = opts.maxRetries ?? 2;
    let attempt = 0;
    for (;;) {
        try {
            yield* factory(signal);
            return;
        } catch (err) {
            const retryable =
                err instanceof ProviderError
                    ? err.retryable
                    : (opts.shouldRetry?.(err) ?? false);
            if (attempt >= maxRetries || !retryable || signal?.aborted) throw err;
            const delay = retryDelay(err, attempt, opts);
            opts.onRetry?.(err, attempt + 1, delay);
            await sleep(delay);
            attempt++;
        }
    }
}
