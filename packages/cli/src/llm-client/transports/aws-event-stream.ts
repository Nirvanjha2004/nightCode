// llm-client/transports/aws-event-stream.ts — AWS event-stream frame parser.
//
// Bedrock streams responses as a binary protocol (not SSE): length-prefixed
// frames with a headers block and a payload. This parser extracts the
// `:event-type` header and the JSON payload from each frame.
//
// ponytail: checksums (CRC32c prelude + message) are NOT validated — Node's
// stdlib has no CRC32c and the lengths alone are sufficient to frame the
// stream. The upgrade path is a small crc32c table implementation; malformed
// frames from a real service have never been observed in practice.

export type AwsEventFrame = {
    eventType: string;
    contentType?: string;
    /** Raw payload bytes. */
    payload: Uint8Array;
};

const EVENT_TYPE = ":event-type";
const CONTENT_TYPE = ":content-type";

/**
 * Parse one frame from a byte view. Returns the frame and the offset of the
 * next frame, or null when the buffer holds fewer than 16 bytes (incomplete).
 * Throws on malformed framing (length overruns).
 */
export function parseAwsEventFrame(buffer: Uint8Array): { frame: AwsEventFrame; next: number } | null {
    if (buffer.length < 16) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);
    // byte 8: prelude CRC (unvalidated — see ponytail note above)

    if (totalLength < 16) {
        throw new Error(`Malformed AWS event-stream frame: totalLength=${totalLength} is below the 16-byte minimum`);
    }
    // Not enough bytes yet — this is an incomplete frame mid-stream, not a
    // malformed one (the caller accumulates bytes and retries).
    if (totalLength > buffer.length) return null;
    const payloadLength = totalLength - headersLength - 16;
    if (payloadLength < 0) {
        throw new Error(`Malformed AWS event-stream frame: headersLength=${headersLength} exceeds total`);
    }

    let offset = 12; // prelude: totalLength(4) + headersLength(4) + crc(4)
    const headersEnd = 12 + headersLength;
    const headerCount = view.getUint16(offset, false);
    offset += 2;

    const headers: Record<string, string> = {};
    for (let i = 0; i < headerCount && offset + 3 <= headersEnd; i++) {
        const nameLen = buffer[offset]!;
        offset += 1;
        const name = new TextDecoder().decode(buffer.subarray(offset, offset + nameLen));
        offset += nameLen;
        const valueType = buffer[offset]!;
        offset += 1;
        // type 7 = string; 0/1 = bool; 2..6 = numeric/bytes (all length-prefixed except bool)
        if (valueType === 7) {
            const len = view.getUint16(offset, false);
            offset += 2;
            const value = new TextDecoder().decode(buffer.subarray(offset, offset + len));
            offset += len;
            headers[name] = value;
        } else if (valueType === 0) {
            headers[name] = "true";
        } else if (valueType === 1) {
            headers[name] = "false";
        } else if (valueType === 2) {
            const len = view.getUint16(offset, false);
            offset += 2;
            headers[name] = String(buffer[offset] ?? 0);
            offset += len;
        } else if (valueType === 3 || valueType === 4 || valueType === 5 || valueType === 6) {
            const len = view.getUint16(offset, false);
            offset += 2;
            offset += len;
            headers[name] = "";
        } else {
            break; // unknown type — skip the rest of this header block safely
        }
    }

    const payload = buffer.subarray(headersEnd, totalLength - 4);
    return {
        frame: {
            eventType: headers[EVENT_TYPE] ?? "unknown",
            contentType: headers[CONTENT_TYPE],
            payload,
        },
        next: totalLength,
    };
}

/** Incrementally parse a byte stream into frames (handles chunk boundaries). */
export async function* parseAwsEventStream(
    body: ReadableStream<Uint8Array> | null
): AsyncGenerator<AwsEventFrame> {
    if (!body) return;
    const reader = body.getReader();
    let buffer = new Uint8Array(0);
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                const merged = new Uint8Array(buffer.length + value.length);
                merged.set(buffer);
                merged.set(value, buffer.length);
                buffer = merged;
            }
            // Drain as many complete frames as the buffer holds.
            for (;;) {
                let parsed: { frame: AwsEventFrame; next: number } | null = null;
                try {
                    parsed = parseAwsEventFrame(buffer);
                } catch (err) {
                    reader.cancel();
                    throw err;
                }
                if (!parsed) break;
                yield parsed.frame;
                buffer = buffer.subarray(parsed.next);
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/** Decode a frame payload as JSON (empty payload → null). */
export function framePayloadJson(frame: AwsEventFrame): Record<string, unknown> | null {
    if (frame.payload.length === 0) return null;
    try {
        return JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
    } catch {
        return null;
    }
}
