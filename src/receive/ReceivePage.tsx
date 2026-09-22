import { useEffect, useSyncExternalStore } from "react";
import { RouteLabel } from "../ui/RouteLabel.tsx";
import type { ReceiverSession } from "./receiver-session.ts";
import type { ReceiverError, ReceiverState, Unavailable } from "./receiver-state.ts";

export function ReceivePage({ session }: { session: ReceiverSession }) {
  const state = useSyncExternalStore(session.store.subscribe, session.store.get);
  useEffect(() => session.start(), [session]);

  return (
    <main data-phase={state.phase}>
      <h1>didi</h1>
      <ReceiveBody state={state} session={session} />
    </main>
  );
}

function ReceiveBody({ state, session }: { state: ReceiverState; session: ReceiverSession }) {
  switch (state.phase) {
    case "joining":
      return <p className="status">Looking for the sender…</p>;
    case "connecting":
      return <p className="status">Connecting to the sender…</p>;
    case "connected":
      return (
        <>
          <p className="status">Connected to the sender.</p>
          <RouteLabel route={state.route} />
        </>
      );
    case "unavailable":
      return (
        <>
          <p className="error" role="alert">
            {unavailableText(state.reason)}
          </p>
          {state.reason !== "invalid-link" && state.reason !== "not-found" && <RetryButton session={session} />}
        </>
      );
    case "failed":
      return (
        <>
          <p className="error" role="alert">
            {errorText(state.error)}
          </p>
          <RetryButton session={session} />
        </>
      );
  }
}

function RetryButton({ session }: { session: ReceiverSession }) {
  return (
    <button type="button" onClick={() => session.retry()}>
      Try again
    </button>
  );
}

function unavailableText(reason: Unavailable): string {
  switch (reason) {
    case "invalid-link":
      return "This link is incomplete. Check that you copied all of it.";
    case "not-found":
      return "This link isn’t active. The sender may have closed their page, or the file was already delivered.";
    case "offline":
      return "The sender’s page isn’t connected right now. It may be reconnecting.";
    case "busy":
      return "Someone else is receiving this file right now.";
    case "full":
      return "didi is at capacity right now. Try again in a few minutes.";
  }
}

function errorText(error: ReceiverError): string {
  switch (error) {
    case "server-unreachable":
      return "Couldn’t reach the didi server. Check your connection.";
    case "server-rejected":
      return "The didi server refused this page’s request. Reload the page and try again.";
    case "signalling-lost":
      return "Lost contact with the didi server before the connection to the sender was made.";
    case "sender-left":
      return "The sender’s page disconnected.";
    case "connect-failed":
      return "Couldn’t connect directly to the sender. One of your networks may block direct connections.";
    case "connection-lost":
      return "The connection to the sender dropped.";
  }
}
