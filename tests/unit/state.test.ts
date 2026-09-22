import assert from "node:assert/strict";
import { test } from "node:test";
import { initialReceiverState, receiverReducer, type ReceiverState } from "../../src/receive/receiver-state.ts";
import { initialSenderState, senderReducer, type SenderEvent, type SenderState } from "../../src/send/sender-state.ts";

const file = { name: "a.bin", size: 10, type: "" };
const link = "https://didi.test/r#AAAAAAAAAAAAAAAAAAAAAA";
const direct = { kind: "direct", sameNetwork: false } as const;

function run(events: SenderEvent[], from: SenderState = initialSenderState): SenderState {
  return events.reduce(senderReducer, from);
}

test("sender: choose, host, connect", () => {
  assert.deepEqual(run([{ type: "file-chosen", file }]), { phase: "registering", file });
  const waiting = run([{ type: "file-chosen", file }, { type: "hosting", link }]);
  assert.deepEqual(waiting, { phase: "waiting", file, link, online: true, notice: null });
  const connected = run([{ type: "peer-joined" }, { type: "peer-connected", route: direct }], waiting);
  assert.deepEqual(connected, { phase: "connected", file, link, online: true, route: direct });
});

test("sender: a lost recipient returns to waiting with a notice, and the link survives", () => {
  const connected = run([{ type: "file-chosen", file }, { type: "hosting", link }, { type: "peer-joined" }, { type: "peer-connected", route: direct }]);
  assert.deepEqual(senderReducer(connected, { type: "peer-lost", notice: "connection-lost" }), {
    phase: "waiting",
    file,
    link,
    online: true,
    notice: "connection-lost",
  });
});

test("sender: signalling drops and comes back without losing the phase", () => {
  const connected = run([{ type: "file-chosen", file }, { type: "hosting", link }, { type: "peer-joined" }, { type: "peer-connected", route: direct }]);
  const offline = senderReducer(connected, { type: "signal-down" });
  assert.equal(offline.phase, "connected");
  assert.ok("online" in offline && !offline.online);
  assert.deepEqual(senderReducer(offline, { type: "hosting", link }), connected);
});

test("sender: events that do not apply to the current phase change nothing", () => {
  assert.equal(senderReducer(initialSenderState, { type: "peer-joined" }), initialSenderState);
  assert.equal(senderReducer(initialSenderState, { type: "peer-connected", route: direct }), initialSenderState);
  const registering = run([{ type: "file-chosen", file }]);
  assert.equal(senderReducer(registering, { type: "file-chosen", file }), registering);
  assert.equal(senderReducer(registering, { type: "peer-lost", notice: "recipient-left" }), registering);
});

test("sender: an oversized file is refused while idle", () => {
  assert.deepEqual(run([{ type: "file-too-large", file }]), { phase: "idle", rejected: file });
});

test("receiver: join, connect, fail, retry", () => {
  let state: ReceiverState = initialReceiverState;
  state = receiverReducer(state, { type: "joined" });
  assert.deepEqual(state, { phase: "connecting" });
  state = receiverReducer(state, { type: "peer-connected", route: direct });
  assert.deepEqual(state, { phase: "connected", route: direct });
  state = receiverReducer(state, { type: "failed", error: "connection-lost" });
  assert.deepEqual(state, { phase: "failed", error: "connection-lost" });
  assert.deepEqual(receiverReducer(state, { type: "retry" }), initialReceiverState);
});

test("receiver: an invalid link cannot be retried; a busy one can", () => {
  const invalid = receiverReducer(initialReceiverState, { type: "unavailable", reason: "invalid-link" });
  assert.equal(receiverReducer(invalid, { type: "retry" }), invalid);
  const busy = receiverReducer(initialReceiverState, { type: "unavailable", reason: "busy" });
  assert.deepEqual(receiverReducer(busy, { type: "retry" }), initialReceiverState);
});
