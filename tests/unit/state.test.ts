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
  assert.deepEqual(run([{ type: "file-chosen", file }]), { phase: "registering", file, retrying: false });
  const waiting = run([{ type: "file-chosen", file }, { type: "hosting", link }]);
  assert.deepEqual(waiting, { phase: "waiting", file, link, online: true, notice: null, report: null });
  const connected = run([{ type: "peer-joined" }, { type: "peer-connected", route: direct }], waiting);
  assert.deepEqual(connected, { phase: "connected", file, link, online: true, route: direct });
});

test("sender: a lost recipient returns to waiting with a notice, and the link survives", () => {
  const connected = run([{ type: "file-chosen", file }, { type: "hosting", link }, { type: "peer-joined" }, { type: "peer-connected", route: direct }]);
  assert.deepEqual(senderReducer(connected, { type: "peer-lost", notice: "connection-lost", report: null }), {
    phase: "waiting",
    file,
    link,
    online: true,
    notice: "connection-lost",
    report: null,
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
  assert.equal(senderReducer(registering, { type: "peer-lost", notice: "recipient-left", report: null }), registering);
});

test("sender: accepted, progress, delivered", () => {
  const connected = run([{ type: "file-chosen", file }, { type: "hosting", link }, { type: "peer-joined" }, { type: "peer-connected", route: direct }]);
  const sending = run([{ type: "accepted" }, { type: "progress", delivered: 4, bytesPerSecond: 8 }], connected);
  assert.deepEqual(sending, { phase: "sending", file, link, online: true, route: direct, delivered: 4, bytesPerSecond: 8, stalledSeconds: null });
  assert.deepEqual(senderReducer(sending, { type: "delivered" }), { phase: "delivered", file, route: direct });
  // An interrupted transfer returns to waiting: the link can be tried again.
  assert.deepEqual(senderReducer(sending, { type: "peer-lost", notice: "connection-lost", report: null }), {
    phase: "waiting",
    file,
    link,
    online: true,
    notice: "connection-lost",
    report: null,
  });
});

test("sender: progress and delivery only count while sending", () => {
  const connected = run([{ type: "file-chosen", file }, { type: "hosting", link }, { type: "peer-joined" }, { type: "peer-connected", route: direct }]);
  assert.equal(senderReducer(connected, { type: "progress", delivered: 4, bytesPerSecond: 8 }), connected);
  assert.equal(senderReducer(connected, { type: "delivered" }), connected);
});

test("sender: an oversized file is refused while idle", () => {
  assert.deepEqual(run([{ type: "file-too-large", file }]), { phase: "idle", rejected: file });
});

test("receiver: join, see the file, receive, complete", () => {
  const meta = { name: "a.bin", size: 10, type: "", lastModified: 0 };
  const result = { kind: "file", name: "a.bin" } as const;
  let state: ReceiverState = initialReceiverState;
  state = receiverReducer(state, { type: "joined" });
  assert.deepEqual(state, { phase: "connecting" });
  state = receiverReducer(state, { type: "offered", file: meta, route: direct });
  assert.deepEqual(state, { phase: "ready", file: meta, route: direct });
  state = receiverReducer(state, { type: "accepted" });
  assert.deepEqual(state, { phase: "receiving", file: meta, route: direct, received: 0, bytesPerSecond: null, stalledSeconds: null });
  state = receiverReducer(state, { type: "progress", received: 5, bytesPerSecond: 100 });
  assert.equal(state.phase === "receiving" && state.received, 5);
  state = receiverReducer(state, { type: "complete", result });
  assert.deepEqual(state, { phase: "complete", file: meta, route: direct, result });
  // The sender closing the connection after completion must not turn success into failure.
  assert.equal(receiverReducer(state, { type: "failed", error: "connection-lost", report: null }), state);
});

test("receiver: a failure mid-transfer can be retried", () => {
  const meta = { name: "a.bin", size: 10, type: "", lastModified: 0 };
  let state: ReceiverState = { phase: "receiving", file: meta, route: direct, received: 3, bytesPerSecond: null, stalledSeconds: null };
  state = receiverReducer(state, { type: "failed", error: "connection-lost", report: null });
  assert.deepEqual(state, { phase: "failed", error: "connection-lost", report: null });
  assert.deepEqual(receiverReducer(state, { type: "retry" }), initialReceiverState);
});

test("receiver: an invalid link cannot be retried; a busy one can", () => {
  const invalid = receiverReducer(initialReceiverState, { type: "unavailable", reason: "invalid-link" });
  assert.equal(receiverReducer(invalid, { type: "retry" }), invalid);
  const busy = receiverReducer(initialReceiverState, { type: "unavailable", reason: "busy" });
  assert.deepEqual(receiverReducer(busy, { type: "retry" }), initialReceiverState);
});

test("sender: a link that can't be registered yet says it is retrying", () => {
  const registering = run([{ type: "file-chosen", file }]);
  assert.deepEqual(senderReducer(registering, { type: "signal-down" }), { phase: "registering", file, retrying: true });
  const waiting = run([{ type: "signal-down" }, { type: "hosting", link }], registering);
  assert.deepEqual(waiting, { phase: "waiting", file, link, online: true, notice: null, report: null });
});

test("stalls are shown while transferring and cleared when data moves", () => {
  const sending = run([
    { type: "file-chosen", file },
    { type: "hosting", link },
    { type: "peer-joined" },
    { type: "peer-connected", route: direct },
    { type: "accepted" },
  ]);
  const stalled = senderReducer(sending, { type: "stalled", seconds: 12 });
  assert.equal(stalled.phase === "sending" && stalled.stalledSeconds, 12);
  const moving = senderReducer(stalled, { type: "stalled", seconds: null });
  assert.equal(moving.phase, "sending");
  assert.equal(moving.phase === "sending" ? moving.stalledSeconds : "wrong phase", null);
  assert.equal(senderReducer(initialSenderState, { type: "stalled", seconds: 12 }), initialSenderState);

  const meta = { name: "a.bin", size: 10, type: "", lastModified: 0 };
  const receiving: ReceiverState = { phase: "receiving", file: meta, route: direct, received: 3, bytesPerSecond: null, stalledSeconds: null };
  const receiverStalled = receiverReducer(receiving, { type: "stalled", seconds: 11 });
  assert.equal(receiverStalled.phase === "receiving" && receiverStalled.stalledSeconds, 11);
  // The same value again changes nothing, so React does not re-render every second.
  assert.equal(receiverReducer(receiverStalled, { type: "stalled", seconds: 11 }), receiverStalled);
});
