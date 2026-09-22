import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createSignalServer, type SignalServer } from "../../server/signal.ts";
import { createHostKey, sessionIdFor } from "../../shared/session-id.ts";
import { parseServerMessage, type ClientMessage, type IceServer, type ServerMessage } from "../../shared/signal-protocol.ts";

const ICE: IceServer[] = [{ urls: "stun:stun.example.test:3478" }];
const GRACE_MS = 150;

let http: Server;
let signal: SignalServer;
let port: number;

before(async () => {
  signal = createSignalServer({ iceServers: ICE, hostGraceMs: GRACE_MS });
  http = createServer();
  http.on("upgrade", (request, socket, head) => signal.handleUpgrade(request, socket, head));
  http.listen(0);
  await once(http, "listening");
  port = (http.address() as AddressInfo).port;
});

after(async () => {
  await signal.close();
  http.close();
});

interface Client {
  ws: WebSocket;
  send(message: ClientMessage | Record<string, unknown>): void;
  next(): Promise<ServerMessage>;
  expectNothing(ms?: number): Promise<void>;
  closed: Promise<number>;
}

async function connect(origin = `http://localhost:${port}`): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/signal`, { origin });
  const inbox: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    const message = parseServerMessage(data.toString("utf8"));
    assert.ok(message !== null, `server sent an invalid message: ${data.toString("utf8")}`);
    const waiter = waiting.shift();
    if (waiter === undefined) inbox.push(message);
    else waiter(message);
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code: number) => resolve(code)));
  await once(ws, "open");
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    next() {
      const queued = inbox.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message within 2 s")), 2000);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async expectNothing(ms = 100) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      assert.deepEqual(inbox, []);
    },
    closed,
  };
}

async function hostSession(hostKey = createHostKey()): Promise<{ host: Client; sessionId: string; hostKey: string }> {
  const host = await connect();
  host.send({ type: "host", hostKey });
  const reply = await host.next();
  assert.equal(reply.type, "hosting");
  assert.ok(reply.type === "hosting");
  return { host, sessionId: reply.sessionId, hostKey };
}

async function joinSession(sessionId: string): Promise<Client> {
  const guest = await connect();
  guest.send({ type: "join", sessionId });
  assert.deepEqual(await guest.next(), { type: "joined", iceServers: ICE });
  return guest;
}

const OFFER = { description: { type: "offer", sdp: "v=0\r\n" } } as const;
const CANDIDATE = {
  candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "abcd" },
} as const;

test("hosting derives the session ID from the host key and hands out ICE servers", async () => {
  const hostKey = createHostKey();
  const host = await connect();
  host.send({ type: "host", hostKey });
  assert.deepEqual(await host.next(), { type: "hosting", sessionId: await sessionIdFor(hostKey), iceServers: ICE });
  host.ws.close(1000);
});

test("joining pairs guest and host and relays negotiation both ways", async () => {
  const { host, sessionId } = await hostSession();
  const guest = await joinSession(sessionId);
  assert.deepEqual(await host.next(), { type: "peer-joined" });

  host.send({ type: "signal", data: OFFER });
  assert.deepEqual(await guest.next(), { type: "signal", data: OFFER });
  guest.send({ type: "signal", data: CANDIDATE });
  assert.deepEqual(await host.next(), { type: "signal", data: CANDIDATE });
  host.ws.close(1000);
});

test("relayed messages are rebuilt from validated fields only", async () => {
  const { host, sessionId } = await hostSession();
  const guest = await joinSession(sessionId);
  await host.next(); // peer-joined
  host.send({ type: "signal", data: { description: { type: "offer", sdp: "v=0\r\n", smuggled: "x".repeat(100) } }, extra: 1 });
  assert.deepEqual(await guest.next(), { type: "signal", data: OFFER });
  host.ws.close(1000);
});

test("unknown sessions are not found", async () => {
  const guest = await connect();
  guest.send({ type: "join", sessionId: "AAAAAAAAAAAAAAAAAAAAAA" });
  assert.deepEqual(await guest.next(), { type: "error", code: "not-found" });
  assert.equal(await guest.closed, 1000);
});

test("a second recipient is turned away while one is connected, and admitted after it leaves", async () => {
  const { host, sessionId } = await hostSession();
  const first = await joinSession(sessionId);
  await host.next(); // peer-joined

  const second = await connect();
  second.send({ type: "join", sessionId });
  assert.deepEqual(await second.next(), { type: "error", code: "busy" });

  first.ws.close();
  assert.deepEqual(await host.next(), { type: "peer-left" });
  await joinSession(sessionId);
  assert.deepEqual(await host.next(), { type: "peer-joined" });
  host.ws.close(1000);
});

test("a host that drops can reclaim its session within the grace period", async () => {
  const { host, sessionId, hostKey } = await hostSession();
  const guest = await joinSession(sessionId);
  await host.next(); // peer-joined

  host.ws.terminate(); // no close frame, as when a network drops
  assert.deepEqual(await guest.next(), { type: "peer-left" });

  const late = await connect();
  late.send({ type: "join", sessionId });
  assert.deepEqual(await late.next(), { type: "error", code: "offline" });

  const back = await connect();
  back.send({ type: "host", hostKey });
  assert.deepEqual(await back.next(), { type: "hosting", sessionId, iceServers: ICE });
  // The guest stayed attached, so the returning host learns it is there.
  assert.deepEqual(await back.next(), { type: "peer-joined" });
  back.ws.close(1000);
});

test("a dropped host's session ends when the grace period runs out", async () => {
  const { host, sessionId } = await hostSession();
  host.ws.terminate();
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 100));
  const guest = await connect();
  guest.send({ type: "join", sessionId });
  assert.deepEqual(await guest.next(), { type: "error", code: "not-found" });
});

test("a host closing on purpose ends the session and releases the recipient", async () => {
  const { host, sessionId } = await hostSession();
  const guest = await joinSession(sessionId);
  await host.next(); // peer-joined
  host.ws.close(1000);
  assert.deepEqual(await guest.next(), { type: "peer-left" });
  assert.equal(await guest.closed, 1000);

  const late = await connect();
  late.send({ type: "join", sessionId });
  assert.deepEqual(await late.next(), { type: "error", code: "not-found" });
});

test("a sender page closing (1001) ends the session immediately", async () => {
  const { host, sessionId } = await hostSession();
  host.ws.close(1001);
  await host.closed;
  const late = await connect();
  late.send({ type: "join", sessionId });
  assert.deepEqual(await late.next(), { type: "error", code: "not-found" });
});

test("the same host key connecting again replaces the old socket", async () => {
  const { host, sessionId, hostKey } = await hostSession();
  const again = await connect();
  again.send({ type: "host", hostKey });
  assert.deepEqual(await again.next(), { type: "hosting", sessionId, iceServers: ICE });
  assert.equal(await host.closed, 4001);
  // The replaced socket closing must not have ended the session.
  const guest = await joinSession(sessionId);
  assert.deepEqual(await again.next(), { type: "peer-joined" });
  guest.ws.close();
  again.ws.close(1000);
});

test("signal messages to a missing counterpart are dropped", async () => {
  const { host } = await hostSession();
  host.send({ type: "signal", data: OFFER });
  await host.expectNothing();
  host.ws.close(1000);
});

test("protocol violations are rejected and the socket closed", async (t) => {
  const cases: [string, (client: Client) => void][] = [
    ["binary frame", (c) => c.ws.send(Buffer.from([1, 2, 3]))],
    ["not JSON", (c) => c.ws.send("hello")],
    ["unknown type", (c) => c.send({ type: "upload", bytes: "..." })],
    ["signal before hosting or joining", (c) => c.send({ type: "signal", data: OFFER })],
    ["malformed host key", (c) => c.send({ type: "host", hostKey: "short" })],
    ["malformed session ID", (c) => c.send({ type: "join", sessionId: "../../etc" })],
    ["malformed description", (c) => c.send({ type: "signal", data: { description: { type: "pranswer", sdp: "" } } })],
  ];
  for (const [name, act] of cases) {
    await t.test(name, async () => {
      const client = await connect();
      act(client);
      assert.deepEqual(await client.next(), { type: "error", code: "bad-request" });
      assert.equal(await client.closed, 1008);
    });
  }
});

test("hosting twice on one socket is rejected", async () => {
  const { host } = await hostSession();
  host.send({ type: "host", hostKey: createHostKey() });
  assert.deepEqual(await host.next(), { type: "error", code: "bad-request" });
  assert.equal(await host.closed, 1008);
});

test("oversized messages are refused by the socket itself", async () => {
  const { host } = await hostSession();
  host.send({ type: "signal", data: { description: { type: "offer", sdp: "x".repeat(20_000) } } });
  assert.equal(await host.closed, 1009);
});

test("a flood of messages is rate-limited", async () => {
  const { host } = await hostSession();
  for (let i = 0; i < 80; i++) host.send({ type: "signal", data: CANDIDATE });
  assert.deepEqual(await host.next(), { type: "error", code: "rate-limited" });
  assert.equal(await host.closed, 1008);
});

test("sockets from other origins are refused", async () => {
  const ws = new WebSocket(`ws://localhost:${port}/signal`, { origin: "https://elsewhere.example" });
  const [error] = (await once(ws, "error")) as [Error];
  assert.match(error.message, /403/);
});
