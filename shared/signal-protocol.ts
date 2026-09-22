// Messages exchanged over the signalling WebSocket. Signalling carries session
// presence and WebRTC negotiation only: never file data, file names or sizes.
// Both ends validate everything they receive with the parsers below.

import { isSessionId } from "./session-id.ts";

export const SIGNAL_PATH = "/signal";
export const MAX_SIGNAL_MESSAGE_BYTES = 16 * 1024;

/**
 * WebSocket close code a host uses to end its session on purpose. The server also
 * ends a session on 1001 (sender page closed). Any other close starts a grace
 * period in which the host can reclaim the session.
 */
export const CLOSE_SESSION_ENDED = 1000;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export type SignalData = { description: SessionDescription } | { candidate: IceCandidate };

export type ClientMessage =
  | { type: "host"; hostKey: string }
  | { type: "join"; sessionId: string }
  | { type: "signal"; data: SignalData };

export type ErrorCode =
  | "not-found" // no such session: never existed, or ended
  | "offline" // session exists but the sender's page is not connected right now
  | "busy" // another recipient is connected
  | "full" // server session limit reached
  | "bad-request"
  | "rate-limited";

export type ServerMessage =
  | { type: "hosting"; sessionId: string; iceServers: IceServer[] }
  | { type: "joined"; iceServers: IceServer[] }
  | { type: "peer-joined" }
  | { type: "peer-left" }
  | { type: "signal"; data: SignalData }
  | { type: "error"; code: ErrorCode };

const MAX_SDP_LENGTH = 12 * 1024;
const ERROR_CODES: readonly ErrorCode[] = ["not-found", "offline", "busy", "full", "bad-request", "rate-limited"];

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function parseJson(text: string): Obj | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseSignalData(value: unknown): SignalData | null {
  if (!isObject(value)) return null;
  if ("description" in value) {
    const description = value.description;
    if (!isObject(description)) return null;
    const type = description.type;
    if ((type !== "offer" && type !== "answer") || !isShortString(description.sdp, MAX_SDP_LENGTH)) return null;
    return { description: { type, sdp: description.sdp } };
  }
  if ("candidate" in value) {
    const candidate = value.candidate;
    if (!isObject(candidate) || !isShortString(candidate.candidate, 1024)) return null;
    const sdpMid = candidate.sdpMid ?? null;
    const sdpMLineIndex = candidate.sdpMLineIndex ?? null;
    const usernameFragment = candidate.usernameFragment ?? null;
    if (sdpMid !== null && !isShortString(sdpMid, 64)) return null;
    if (sdpMLineIndex !== null && !(typeof sdpMLineIndex === "number" && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex < 64)) return null;
    if (usernameFragment !== null && !isShortString(usernameFragment, 256)) return null;
    return { candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex, usernameFragment } };
  }
  return null;
}

export function parseClientMessage(text: string): ClientMessage | null {
  const message = parseJson(text);
  if (message === null) return null;
  switch (message.type) {
    case "host":
      return isShortString(message.hostKey, 64) ? { type: "host", hostKey: message.hostKey } : null;
    case "join":
      return isSessionId(message.sessionId) ? { type: "join", sessionId: message.sessionId } : null;
    case "signal": {
      const data = parseSignalData(message.data);
      return data === null ? null : { type: "signal", data };
    }
    default:
      return null;
  }
}

export function parseIceServers(value: unknown): IceServer[] | null {
  if (!Array.isArray(value)) return null;
  const servers: IceServer[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const urls = entry.urls;
    const validUrls = typeof urls === "string" || (Array.isArray(urls) && urls.every((url) => typeof url === "string"));
    if (!validUrls) return null;
    const server: IceServer = { urls: urls as string | string[] };
    if (typeof entry.username === "string") server.username = entry.username;
    if (typeof entry.credential === "string") server.credential = entry.credential;
    servers.push(server);
  }
  return servers;
}

export function parseServerMessage(text: string): ServerMessage | null {
  const message = parseJson(text);
  if (message === null) return null;
  switch (message.type) {
    case "hosting": {
      const iceServers = parseIceServers(message.iceServers);
      return isSessionId(message.sessionId) && iceServers !== null ? { type: "hosting", sessionId: message.sessionId, iceServers } : null;
    }
    case "joined": {
      const iceServers = parseIceServers(message.iceServers);
      return iceServers === null ? null : { type: "joined", iceServers };
    }
    case "peer-joined":
      return { type: "peer-joined" };
    case "peer-left":
      return { type: "peer-left" };
    case "signal": {
      const data = parseSignalData(message.data);
      return data === null ? null : { type: "signal", data };
    }
    case "error": {
      const code = ERROR_CODES.find((known) => known === message.code);
      return code === undefined ? null : { type: "error", code };
    }
    default:
      return null;
  }
}
