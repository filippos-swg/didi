// The sender's state machine. A pure function: the SenderSession performs the
// side effects and reports what happened as events.

import type { ConnectionReport } from "../net/connection-report.ts";
import type { Route } from "../net/peer.ts";

export interface FileInfo {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/** Why the last attempt with a recipient ended. The link itself still works. */
export type SenderNotice =
  | "recipient-left"
  | "connect-failed"
  | "connection-lost"
  | "recipient-cancelled"
  | "integrity-failed"
  | "recipient-save-failed"
  | "transfer-failed";

/** Why sharing stopped altogether. */
export type SenderError = "server-full" | "server-rejected" | "file-unreadable";

interface Shared {
  file: FileInfo;
  link: string;
  /** Whether the signalling connection is up. Only matters while the link is waiting to be opened. */
  online: boolean;
}

export type SenderState =
  | { phase: "idle"; rejected: FileInfo | null }
  | { phase: "registering"; file: FileInfo; retrying: boolean }
  | ({ phase: "waiting"; notice: SenderNotice | null; report: ConnectionReport | null } & Shared)
  | ({ phase: "connecting" } & Shared)
  | ({ phase: "connected"; route: Route } & Shared)
  | ({ phase: "sending"; route: Route; delivered: number; bytesPerSecond: number | null; stalledSeconds: number | null } & Shared)
  | { phase: "delivered"; file: FileInfo; route: Route }
  | { phase: "failed"; error: SenderError };

export type SenderEvent =
  | { type: "file-too-large"; file: FileInfo }
  | { type: "file-chosen"; file: FileInfo }
  | { type: "hosting"; link: string }
  | { type: "signal-down" }
  | { type: "peer-joined" }
  | { type: "peer-connected"; route: Route }
  | { type: "accepted" }
  | { type: "progress"; delivered: number; bytesPerSecond: number | null }
  /** Nothing has moved for this many seconds, or null once it moves again. */
  | { type: "stalled"; seconds: number | null }
  | { type: "delivered" }
  | { type: "peer-lost"; notice: SenderNotice; report: ConnectionReport | null }
  | { type: "fatal"; error: SenderError }
  | { type: "reset" };

export const initialSenderState: SenderState = { phase: "idle", rejected: null };

function shared(state: Shared): Shared {
  return { file: state.file, link: state.link, online: state.online };
}

export function senderReducer(state: SenderState, event: SenderEvent): SenderState {
  switch (event.type) {
    case "reset":
      return initialSenderState;
    case "fatal":
      return { phase: "failed", error: event.error };
    case "file-too-large":
      return state.phase === "idle" ? { phase: "idle", rejected: event.file } : state;
    case "file-chosen":
      return state.phase === "idle" ? { phase: "registering", file: event.file, retrying: false } : state;
    case "hosting":
      if (state.phase === "registering") return { phase: "waiting", file: state.file, link: event.link, online: true, notice: null, report: null };
      // Reclaimed after a reconnect: same session, same link.
      return "online" in state && !state.online ? { ...state, online: true } : state;
    case "signal-down":
      if (state.phase === "registering") return state.retrying ? state : { ...state, retrying: true };
      return "online" in state && state.online ? { ...state, online: false } : state;
    case "peer-joined":
      return state.phase === "waiting" ? { phase: "connecting", ...shared(state) } : state;
    case "peer-connected":
      return state.phase === "connecting" ? { phase: "connected", ...shared(state), route: event.route } : state;
    case "accepted":
      return state.phase === "connected"
        ? { phase: "sending", ...shared(state), route: state.route, delivered: 0, bytesPerSecond: null, stalledSeconds: null }
        : state;
    case "progress":
      return state.phase === "sending" ? { ...state, delivered: event.delivered, bytesPerSecond: event.bytesPerSecond } : state;
    case "stalled":
      return state.phase === "sending" && state.stalledSeconds !== event.seconds ? { ...state, stalledSeconds: event.seconds } : state;
    case "delivered":
      return state.phase === "sending" ? { phase: "delivered", file: state.file, route: state.route } : state;
    case "peer-lost":
      return state.phase === "connecting" || state.phase === "connected" || state.phase === "sending"
        ? { phase: "waiting", ...shared(state), notice: event.notice, report: event.report }
        : state;
  }
}
