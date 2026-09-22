import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { FileMeta } from "../transfer/protocol.ts";
import { canSaveToDisk } from "../transfer/sinks.ts";
import { ConnectionDetails } from "../ui/ConnectionDetails.tsx";
import { FileSummary } from "../ui/FileSummary.tsx";
import { RouteLabel } from "../ui/RouteLabel.tsx";
import { TransferProgress } from "../ui/TransferProgress.tsx";
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
    case "ready":
      return (
        <>
          <FileSummary file={state.file} />
          <RouteLabel route={state.route} />
          <p className="hint">
            The file comes straight from the sender’s browser. {canSaveToDisk() ? "You’ll choose where to save it. " : ""}Keep this page open until
            it finishes.
          </p>
          <button type="button" onClick={() => session.receive()}>
            Receive file
          </button>
        </>
      );
    case "choosing":
      return (
        <>
          <FileSummary file={state.file} />
          <RouteLabel route={state.route} />
          <p className="status">Choose where to save the file…</p>
        </>
      );
    case "receiving":
      return (
        <>
          <FileSummary file={state.file} />
          <RouteLabel route={state.route} />
          <TransferProgress done={state.received} total={state.file.size} bytesPerSecond={state.bytesPerSecond} verb="received" />
          <button type="button" className="secondary" onClick={() => session.cancel()}>
            Stop receiving
          </button>
        </>
      );
    case "complete":
      return (
        <>
          <FileSummary file={state.file} />
          <p className="success">Received. Your copy matches the sender’s.</p>
          <RouteLabel route={state.route} />
          {state.result.kind === "blob" ? <SaveButton blob={state.result.blob} file={state.file} /> : <p className="saved">Saved as {state.result.name}.</p>}
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
          {state.report !== null && <ConnectionDetails report={state.report} other="sender" />}
          <RetryButton session={session} />
        </>
      );
  }
}

function SaveButton({ blob, file }: { blob: Blob; file: FileMeta }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <a className="button" href={url} download={file.name}>
      Save file
    </a>
  );
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
      return "Couldn’t connect directly to the sender.";
    case "connection-lost":
      return "The connection to the sender dropped.";
    case "cancelled":
      return "You stopped receiving. The partial file was discarded.";
    case "sender-cancelled":
      return "The sender stopped sharing this file.";
    case "sender-file-unreadable":
      return "The sender’s copy of the file couldn’t be read, so the transfer stopped.";
    case "integrity-failed":
      return "The received data didn’t match the sender’s copy, so it was discarded.";
    case "save-failed":
      return "Your browser couldn’t save the file. Your disk may be full.";
    case "transfer-failed":
      return "The transfer stopped because of an unexpected error.";
  }
}
