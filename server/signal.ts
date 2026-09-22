// Signalling: pairs one sender (host) with one recipient (guest) per session and
// relays WebRTC negotiation between them. All state is in memory. Nothing about
// a session is logged or written to disk.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { sessionIdFor } from "../shared/session-id.ts";
import {
  CLOSE_SESSION_ENDED,
  MAX_SIGNAL_MESSAGE_BYTES,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type IceServer,
  type ServerMessage,
  type SignalData,
} from "../shared/signal-protocol.ts";

export interface SignalOptions {
  iceServers: IceServer[];
  /** How long a session survives its host's connection dropping, so the host can reclaim it. */
  hostGraceMs?: number;
  maxSessions?: number;
  heartbeatMs?: number;
  /** Origins allowed to open a signalling socket in addition to the server's own host. */
  allowedOrigins?: readonly string[];
}

export interface SignalServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  sessionCount(): number;
  close(): Promise<void>;
}

interface Session {
  readonly id: string;
  host: Peer | null;
  guest: Peer | null;
  hostGoneTimer: NodeJS.Timeout | null;
}

interface Peer {
  readonly socket: WebSocket;
  role: "none" | "host" | "guest";
  session: Session | null;
  tokens: number;
  lastRefill: number;
  alive: boolean;
  queue: Promise<void>;
}

// Negotiation needs a handful of messages; anything chattier is not negotiation.
const RATE_BURST = 50;
const RATE_PER_SECOND = 10;
const CLOSE_POLICY = 1008;
const CLOSE_REPLACED = 4001;
// A browser closing or navigating away from the sender page sends 1001. The host
// key lived only in that page, so the session cannot come back.
const CLOSE_GOING_AWAY = 1001;

export function createSignalServer(options: SignalOptions): SignalServer {
  const hostGraceMs = options.hostGraceMs ?? 30_000;
  const maxSessions = options.maxSessions ?? 10_000;
  const allowedOrigins = options.allowedOrigins ?? [];
  const sessions = new Map<string, Session>();
  const peers = new Set<Peer>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });

  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
  }, options.heartbeatMs ?? 25_000);
  heartbeat.unref();

  function send(peer: Peer, message: ServerMessage): void {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
  }

  function reject(peer: Peer, code: ErrorCode): void {
    send(peer, { type: "error", code });
    const violation = code === "bad-request" || code === "rate-limited";
    peer.socket.close(violation ? CLOSE_POLICY : 1000);
  }

  function takeToken(peer: Peer): boolean {
    const now = Date.now();
    peer.tokens = Math.min(RATE_BURST, peer.tokens + ((now - peer.lastRefill) / 1000) * RATE_PER_SECOND);
    peer.lastRefill = now;
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }

  async function host(peer: Peer, hostKey: string): Promise<void> {
    if (peer.role !== "none") return reject(peer, "bad-request");
    const id = await sessionIdFor(hostKey);
    if (id === null) return reject(peer, "bad-request");
    if (peer.socket.readyState !== WebSocket.OPEN) return; // closed while hashing

    let session = sessions.get(id);
    if (session === undefined) {
      if (sessions.size >= maxSessions) return reject(peer, "full");
      session = { id, host: null, guest: null, hostGoneTimer: null };
      sessions.set(id, session);
    } else if (session.host !== null) {
      // The same key connected again before its old socket was noticed dead.
      const previous = session.host;
      previous.role = "none";
      previous.session = null;
      previous.socket.close(CLOSE_REPLACED, "replaced");
    }
    if (session.hostGoneTimer !== null) {
      clearTimeout(session.hostGoneTimer);
      session.hostGoneTimer = null;
    }
    session.host = peer;
    peer.role = "host";
    peer.session = session;
    send(peer, { type: "hosting", sessionId: id, iceServers: options.iceServers });
    if (session.guest !== null) send(peer, { type: "peer-joined" });
  }

  function join(peer: Peer, sessionId: string): void {
    if (peer.role !== "none") return reject(peer, "bad-request");
    const session = sessions.get(sessionId);
    if (session === undefined) return reject(peer, "not-found");
    if (session.host === null) return reject(peer, "offline");
    if (session.guest !== null) return reject(peer, "busy");
    session.guest = peer;
    peer.role = "guest";
    peer.session = session;
    send(peer, { type: "joined", iceServers: options.iceServers });
    send(session.host, { type: "peer-joined" });
  }

  function relay(peer: Peer, data: SignalData): void {
    const session = peer.session;
    if (session === null) return reject(peer, "bad-request");
    const other = peer.role === "host" ? session.guest : session.host;
    // The other side may have just left; dropping the message is correct then.
    if (other !== null) send(other, { type: "signal", data });
  }

  function handle(peer: Peer, message: ClientMessage): Promise<void> | void {
    switch (message.type) {
      case "host":
        return host(peer, message.hostKey);
      case "join":
        return join(peer, message.sessionId);
      case "signal":
        return relay(peer, message.data);
    }
  }

  function endSession(session: Session): void {
    if (session.hostGoneTimer !== null) clearTimeout(session.hostGoneTimer);
    sessions.delete(session.id);
    const guest = session.guest;
    session.guest = null;
    if (guest !== null) {
      guest.role = "none";
      guest.session = null;
      guest.socket.close(1000);
    }
  }

  function onClose(peer: Peer, code: number): void {
    peers.delete(peer);
    const session = peer.session;
    peer.session = null;
    if (session === null) return;

    if (peer.role === "guest") {
      session.guest = null;
      if (session.host !== null) send(session.host, { type: "peer-left" });
      return;
    }

    session.host = null;
    if (session.guest !== null) send(session.guest, { type: "peer-left" });
    if (code === CLOSE_SESSION_ENDED || code === CLOSE_GOING_AWAY) {
      endSession(session);
    } else {
      session.hostGoneTimer = setTimeout(() => endSession(session), hostGraceMs);
    }
  }

  function accept(socket: WebSocket): void {
    const peer: Peer = {
      socket,
      role: "none",
      session: null,
      tokens: RATE_BURST,
      lastRefill: Date.now(),
      alive: true,
      queue: Promise.resolve(),
    };
    peers.add(peer);

    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return reject(peer, "bad-request");
      if (!takeToken(peer)) return reject(peer, "rate-limited");
      const message = parseClientMessage(rawToString(raw));
      if (message === null) return reject(peer, "bad-request");
      // Handle one message at a time, in order, even though hosting awaits a hash.
      peer.queue = peer.queue
        .then(() => handle(peer, message))
        .catch((error: unknown) => {
          console.error("signal: handler failed", error);
          socket.close(1011);
        });
    });
    socket.on("close", (code: number) => onClose(peer, code));
    socket.on("error", () => {
      // A close event always follows; nothing else to do.
    });
  }

  function originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return false;
    if (allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }

  return {
    handleUpgrade(request, socket, head) {
      if (!originAllowed(request)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, accept);
    },
    sessionCount: () => sessions.size,
    close() {
      clearInterval(heartbeat);
      for (const session of sessions.values()) {
        if (session.hostGoneTimer !== null) clearTimeout(session.hostGoneTimer);
      }
      sessions.clear();
      for (const peer of peers) peer.socket.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}
