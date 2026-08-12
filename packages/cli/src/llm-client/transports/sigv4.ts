// llm-client/transports/sigv4.ts — AWS Signature Version 4.
//
// Minimal SigV4 implementation used to sign Bedrock requests. Tested offline
// against the AWS documentation's published test vectors (see
// sigv4.check.ts). Only the HMAC chain + canonical request building live
// here — no AWS SDK dependency.

import { createHmac, createHash } from "node:crypto";

export type AwsCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
};

export type SigV4Params = {
    method: string;
    /** Full URL including scheme and (possibly empty) query. */
    url: string;
    /** Extra request headers (content-type, accept, ...) — sent, not signed. */
    headers?: Record<string, string>;
    /** UTF-8 body, or undefined for empty. */
    body?: string;
    service: string;
    region: string;
    credentials: AwsCredentials;
    now?: Date;
    /** Also sign the x-amz-content-sha256 header (defaults false — the payload hash always lives in the canonical request). */
    includePayloadHashHeader?: boolean;
};

export function sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data, "utf8").digest();
}

function uriEncode(input: string): string {
    return encodeURIComponent(input).replace(/[!'()*]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/** URI-encode each path segment separately so `/` survives. */
function encodePath(pathname: string): string {
    return pathname
        .split("/")
        .map((seg) => uriEncode(seg))
        .join("/");
}

/**
 * Build the SigV4 `Authorization` header plus the signed request headers
 * (host, x-amz-date, x-amz-content-sha256, optional x-amz-security-token).
 * The minimum header set is signed; everything else is sent unsigned.
 */
export function signRequest(params: SigV4Params): Record<string, string> {
    const { method, url, service, region, credentials, body = "" } = params;
    const now = params.now ?? new Date();
    const parsed = new URL(url);

    const canonicalUri = encodePath(parsed.pathname || "/");
    const canonicalQuery = [...parsed.searchParams.entries()]
        .map(([k, v]) => `${uriEncode(k)}${v ? `=${uriEncode(v)}` : ""}`)
        .sort()
        .join("&");

    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const signedHeaders: Record<string, string> = {
        host: parsed.host,
        "x-amz-date": amzDate,
    };
    if (params.includePayloadHashHeader) {
        signedHeaders["x-amz-content-sha256"] = payloadHash;
    }
    if (credentials.sessionToken) {
        signedHeaders["x-amz-security-token"] = credentials.sessionToken;
    }

    const headerNames = Object.keys(signedHeaders).sort();
    const canonicalHeaders = headerNames
        .map((name) => `${name}:${signedHeaders[name]}\n`)
        .join("");

    const canonicalRequest = [
        method.toUpperCase(),
        canonicalUri,
        canonicalQuery,
        canonicalHeaders,
        headerNames.join(";"),
        payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");

    const authorization =
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${headerNames.join(";")}, Signature=${signature}`;

    return {
        ...signedHeaders,
        ...params.headers,
        Authorization: authorization,
    };
}
