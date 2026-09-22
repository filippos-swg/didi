import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64Url, toBase64Url } from "../../shared/base64url.ts";
import { createHostKey, isSessionId, sessionIdFor } from "../../shared/session-id.ts";

test("base64url round-trips arbitrary bytes", () => {
  for (let length = 0; length < 70; length++) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const text = toBase64Url(bytes);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(fromBase64Url(text), bytes);
  }
});

test("base64url rejects non-alphabet input", () => {
  assert.equal(fromBase64Url("abc+"), null);
  assert.equal(fromBase64Url("abc="), null);
  assert.equal(fromBase64Url("a"), null); // no valid encoding has length 4n+1
});

test("a host key derives a stable 128-bit session ID", async () => {
  const hostKey = createHostKey();
  assert.equal(hostKey.length, 43);
  const id = await sessionIdFor(hostKey);
  assert.ok(id !== null && isSessionId(id));
  assert.equal(id.length, 22);
  assert.equal(await sessionIdFor(hostKey), id);
  assert.notEqual(await sessionIdFor(createHostKey()), id);
});

test("malformed host keys derive nothing", async () => {
  assert.equal(await sessionIdFor(""), null);
  assert.equal(await sessionIdFor(createHostKey().slice(0, 42)), null);
  assert.equal(await sessionIdFor(toBase64Url(new Uint8Array(31))), null);
  assert.equal(await sessionIdFor("not a key!"), null);
});

test("session ID shape check", () => {
  assert.ok(isSessionId("AAAAAAAAAAAAAAAAAAAAAA"));
  assert.ok(!isSessionId("AAAAAAAAAAAAAAAAAAAAA"));
  assert.ok(!isSessionId("AAAAAAAAAAAAAAAAAAAAA/"));
  assert.ok(!isSessionId(42));
});
