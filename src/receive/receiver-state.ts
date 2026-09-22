// The recipient's state machine. A pure function: the ReceiverSession performs
// the side effects and reports what happened as events.

import type { ErrorCode } from "../../shared/signal-protocol.ts";
import type { ConnectionReport } from "../net/connection-report.ts";
import type { Route } from "../net/peer.ts";
import type { FileMeta } from "../transfer/protocol.ts";
import type { SinkResult } from "../transfer/sinks.ts";

/** The link cannot be used right now. Nothing was attempted. */
export type Unavailable = "invalid-link" | Extract<ErrorCode, "not-found" | "offline" | "busy" | "full">;

/** An attempt was made and did not succeed. */
export type ReceiverError =
  | "server-unreachable"
  | "server-rejected"
  | "signalling-lost"
  | "sender-left"
  | "connect-failed"
  | "connection-lost"
  | "cancelled"
  | "sender-cancelled"
  | "sender-file-unreadable"
  | "integrity-failed"
  | "save-failed"
  | "transfer-failed";

export type ReceiverState =
  | { phase: "joining" }
  | { phase: "unavailable"; reason: Unavailable }
  | { phase: "connecting" }
  | { phase: "ready"; file: FileMeta; route: Route }
  | { phase: "choosing"; file: FileMeta; route: Route } // the save dialog is open
  | { phase: "receiving"; file: FileMeta; route: Route; received: number; bytesPerSecond: number | null }
  | { phase: "complete"; file: FileMeta; route: Route; result: SinkResult }
  | { phase: "failed"; error: ReceiverError; report: ConnectionReport | null };

export type ReceiverEvent =
  | { type: "unavailable"; reason: Unavailable }
  | { type: "joined" }
  | { type: "offered"; file: FileMeta; route: Route }
  | { type: "choosing" }
  | { type: "choice-cancelled" }
  | { type: "accepted" }
  | { type: "progress"; received: number; bytesPerSecond: number | null }
  | { type: "complete"; result: SinkResult }
  | { type: "failed"; error: ReceiverError; report: ConnectionReport | null }
  | { type: "retry" };

export const initialReceiverState: ReceiverState = { phase: "joining" };

export function receiverReducer(state: ReceiverState, event: ReceiverEvent): ReceiverState {
  switch (event.type) {
    case "unavailable":
      return state.phase === "joining" ? { phase: "unavailable", reason: event.reason } : state;
    case "joined":
      return state.phase === "joining" ? { phase: "connecting" } : state;
    case "offered":
      return state.phase === "connecting" ? { phase: "ready", file: event.file, route: event.route } : state;
    case "choosing":
      return state.phase === "ready" ? { phase: "choosing", file: state.file, route: state.route } : state;
    case "choice-cancelled":
      return state.phase === "choosing" ? { phase: "ready", file: state.file, route: state.route } : state;
    case "accepted":
      return state.phase === "ready" || state.phase === "choosing"
        ? { phase: "receiving", file: state.file, route: state.route, received: 0, bytesPerSecond: null }
        : state;
    case "progress":
      return state.phase === "receiving" ? { ...state, received: event.received, bytesPerSecond: event.bytesPerSecond } : state;
    case "complete":
      return state.phase === "receiving" ? { phase: "complete", file: state.file, route: state.route, result: event.result } : state;
    case "failed":
      return state.phase === "joining" || state.phase === "connecting" || state.phase === "ready" || state.phase === "choosing" || state.phase === "receiving"
        ? { phase: "failed", error: event.error, report: event.report }
        : state;
    case "retry":
      return state.phase === "failed" || (state.phase === "unavailable" && state.reason !== "invalid-link") ? initialReceiverState : state;
  }
}
