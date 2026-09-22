// A session is owned by whoever holds its host key. The session ID is derived
// from the key, so the server can check ownership by re-hashing and never has
// to store a secret. See docs/DECISIONS.md, "Session IDs".

import { fromBase64Url, toBase64Url } from "./base64url.ts";

const HOST_KEY_BYTES = 32; // 256 bits, never leaves the sender except to the signalling server
const SESSION_ID_BYTES = 16; // 128 bits, shared in the link

export function createHostKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(HOST_KEY_BYTES)));
}

/** Returns null if the host key is malformed. */
export async function sessionIdFor(hostKey: string): Promise<string | null> {
  const bytes = fromBase64Url(hostKey);
  if (bytes === null || bytes.length !== HOST_KEY_BYTES) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return toBase64Url(digest.subarray(0, SESSION_ID_BYTES));
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
}
