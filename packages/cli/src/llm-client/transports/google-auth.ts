// llm-client/transports/google-auth.ts — OAuth token resolution for Vertex AI.
//
// Sources, in order: GOOGLE_OAUTH_ACCESS_TOKEN (explicit), then Application
// Default Credentials via GOOGLE_APPLICATION_CREDENTIALS (service-account
// JSON file) or GOOGLE_APPLICATION_CREDENTIALS_JSON (inline). Service-account
// flow: sign a JWT assertion with the private key and exchange it at the
// token endpoint. Tokens are cached until shortly before expiry.

import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { logger } from "../../logger";

type ServiceAccount = {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
};

const SCOPES = "https://www.googleapis.com/auth/cloud-platform";
const CACHE_SKEW_MS = 60_000;

let cachedToken: { token: string; expiresAt: number } | undefined;

function base64url(input: string | Buffer): string {
    return Buffer.from(input).toString("base64url");
}

function loadServiceAccount(): ServiceAccount | undefined {
    const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (inline) {
        try {
            return JSON.parse(inline) as ServiceAccount;
        } catch {
            logger.error("[GoogleAuth] GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON");
            return undefined;
        }
    }
    const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (path && existsSync(path)) {
        try {
            return JSON.parse(readFileSync(path, "utf-8")) as ServiceAccount;
        } catch (err) {
            logger.error(`[GoogleAuth] Failed to read ${path}: ${(err as Error).message}`);
            return undefined;
        }
    }
    return undefined;
}

function signJwt(account: ServiceAccount): string | undefined {
    if (!account.client_email || !account.private_key || !account.token_uri) {
        logger.error("[GoogleAuth] Service account JSON is missing client_email / private_key / token_uri");
        return undefined;
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
        JSON.stringify({
            iss: account.client_email,
            scope: SCOPES,
            aud: account.token_uri,
            iat: now,
            exp: now + 3600,
        })
    );
    const signingInput = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    const signature = signer.sign(account.private_key, "base64url");
    return `${signingInput}.${signature}`;
}

/** Exchange a signed JWT for an access token at the token endpoint. */
export async function exchangeJwtForToken(account: ServiceAccount, signal?: AbortSignal): Promise<string> {
    const assertion = signJwt(account);
    if (!assertion) throw new Error("Unable to sign service-account JWT");
    const res = await fetch(account.token_uri ?? "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
        signal,
    });
    if (!res.ok) {
        throw new Error(`Token exchange failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Token exchange returned no access_token");
    return data.access_token;
}

/**
 * Resolve a Google OAuth access token. Returns undefined when no credential
 * is available (caller surfaces a clear AuthenticationError).
 */
export async function resolveGoogleAccessToken(signal?: AbortSignal): Promise<string | undefined> {
    const explicit = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    if (explicit?.trim()) return explicit.trim();

    if (cachedToken && Date.now() < cachedToken.expiresAt - CACHE_SKEW_MS) {
        return cachedToken.token;
    }

    const account = loadServiceAccount();
    if (!account) return undefined;

    const token = await exchangeJwtForToken(account, signal);
    cachedToken = { token, expiresAt: Date.now() + 3600_000 };
    return token;
}
