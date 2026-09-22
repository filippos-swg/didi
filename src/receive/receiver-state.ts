// The recipient's state machine. A pure function: the ReceiverSession performs
// the side effects and reports what happened as events.

import type { ErrorCode } from "../../shared/signal-protocol.ts";
import type { Route } from "../net/peer.ts";

/** The link cannot be used right now. Nothing was attempted. */
export type Unavailable = "invalid-link" | Extract<ErrorCode, "not-found" | "offline" | "busy" | "full">;

/** An attempt was made and did not succeed. */
export type ReceiverError =
  | "server-unreachable"
  | "server-rejected"
  | "signalling-lost"
  | "sender-left"
  | "connect-failed"
  | "connection-lost";

export type ReceiverState =
  | { phase: "joining" }
  | { phase: "unavailable"; reason: Unavailable }
  | { phase: "connecting" }
  | { phase: "connected"; route: Route }
  | { phase: "failed"; error: ReceiverError };

export type ReceiverEvent =
  | { type: "unavailable"; reason: Unavailable }
  | { type: "joined" }
  | { type: "peer-connected"; route: Route }
  | { type: "failed"; error: ReceiverError }
  | { type: "retry" };

export const initialReceiverState: ReceiverState = { phase: "joining" };

export function receiverReducer(state: ReceiverState, event: ReceiverEvent): ReceiverState {
  switch (event.type) {
    case "unavailable":
      return state.phase === "joining" ? { phase: "unavailable", reason: event.reason } : state;
    case "joined":
      return state.phase === "joining" ? { phase: "connecting" } : state;
    case "peer-connected":
      return state.phase === "connecting" ? { phase: "connected", route: event.route } : state;
    case "failed":
      return state.phase === "joining" || state.phase === "connecting" || state.phase === "connected"
        ? { phase: "failed", error: event.error }
        : state;
    case "retry":
      return state.phase === "failed" || (state.phase === "unavailable" && state.reason !== "invalid-link") ? initialReceiverState : state;
  }
}
