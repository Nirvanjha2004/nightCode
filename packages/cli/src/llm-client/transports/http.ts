// llm-client/transports/http.ts — shared HTTP plumbing for all transports.
//
// Preserves the cancellation semantics the Groq client shipped with: Bun's
// fetch does not reliably reject an in-flight request when its AbortSignal
// fires, so every request races against an abort watchdog that rejects the
// instant the signal fires. The orphaned request settles in the background
// and is swallowed.

import { CancelledError } from "../../agent/types";
import { TimeoutError } from "../errors";

export const DEFAULT_TIMEOUT_MS = 120_000;

export type HttpOptions = {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Extra headers merged over defaults. */
    headers?: Record<string, string>;
};

/**
 * fetch() with (a) an AbortSignal watchdog so cancellation settles in ~ms and
 * (b) an optional wall-clock timeout that rejects with TimeoutError.
 */
export async function fetchWithWatchdog(
    url: string,
    init: RequestInit,
    opts: HttpOptions = {}
): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = opts.signal;

    // Abort watchdog (user cancellation): reject with CancelledError the
    // instant the signal fires, regardless of the fetch's own behavior.
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new CancelledError());
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
    });

    // Timeout watchdog: bounded requests never hang the loop forever.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new TimeoutError({ message: `Request timed out after ${timeoutMs}ms` }));
        }, timeoutMs);
    });

    const requestPromise = fetch(url, init);
    requestPromise.catch(() => {}); // never surface an orphaned settle

    try {
        return await Promise.race([requestPromise, abortPromise, timeoutPromise]);
    } finally {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

/** Read the response body as text (bounded) for error classification. */
export async function bodyText(res: Response): Promise<string> {
    try {
        const buf = await res.arrayBuffer();
        return new TextDecoder().decode(buf).slice(0, 8000);
    } catch {
        return "";
    }
}

/** Small helper: build a URL with query params (drops undefined). */
export function withQuery(url: string, params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) search.set(k, String(v));
    }
    const qs = search.toString();
    return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}
