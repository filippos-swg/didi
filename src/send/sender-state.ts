// The sender's state machine. A pure function: the SenderSession performs the
// side effects and reports what happened as events.

import type { Route } from "../net/peer.ts";

export interface FileInfo {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/** Why the last attempt with a recipient ended. The link itself still works. */
export type SenderNotice = "recipient-left" | "connect-failed" | "connection-lost";

/** Why sharing stopped altogether. */
export type SenderError = "server-full" | "server-rejected";

export type SenderState =
  | { phase: "idle"; rejected: FileInfo | null }
  | { phase: "registering"; file: FileInfo }
  | { phase: "waiting"; file: FileInfo; link: string; online: boolean; notice: SenderNotice | null }
  | { phase: "connecting"; file: FileInfo; link: string; online: boolean }
  | { phase: "connected"; file: FileInfo; link: string; online: boolean; route: Route }
  | { phase: "failed"; error: SenderError };

export type SenderEvent =
  | { type: "file-too-large"; file: FileInfo }
  | { type: "file-chosen"; file: FileInfo }
  | { type: "hosting"; link: string }
  | { type: "signal-down" }
  | { type: "peer-joined" }
  | { type: "peer-connected"; route: Route }
  | { type: "peer-lost"; notice: SenderNotice }
  | { type: "fatal"; error: SenderError }
  | { type: "reset" };

export const initialSenderState: SenderState = { phase: "idle", rejected: null };

export function senderReducer(state: SenderState, event: SenderEvent): SenderState {
  switch (event.type) {
    case "reset":
      return initialSenderState;
    case "fatal":
      return { phase: "failed", error: event.error };
    case "file-too-large":
      return state.phase === "idle" ? { phase: "idle", rejected: event.file } : state;
    case "file-chosen":
      return state.phase === "idle" ? { phase: "registering", file: event.file } : state;
    case "hosting":
      if (state.phase === "registering") return { phase: "waiting", file: state.file, link: event.link, online: true, notice: null };
      // Reclaimed after a reconnect: same session, same link.
      return "online" in state && !state.online ? { ...state, online: true } : state;
    case "signal-down":
      return "online" in state && state.online ? { ...state, online: false } : state;
    case "peer-joined":
      return state.phase === "waiting" ? { phase: "connecting", file: state.file, link: state.link, online: state.online } : state;
    case "peer-connected":
      return state.phase === "connecting" ? { ...state, phase: "connected", route: event.route } : state;
    case "peer-lost":
      return state.phase === "connecting" || state.phase === "connected"
        ? { phase: "waiting", file: state.file, link: state.link, online: state.online, notice: event.notice }
        : state;
  }
}
