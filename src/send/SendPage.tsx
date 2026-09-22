import { useEffect, useState, useSyncExternalStore, type DragEvent } from "react";
import { formatBytes } from "../format.ts";
import { RouteLabel } from "../ui/RouteLabel.tsx";
import type { SenderSession } from "./sender-session.ts";
import type { FileInfo, SenderError, SenderNotice, SenderState } from "./sender-state.ts";

export function SendPage({ session }: { session: SenderSession }) {
  const state = useSyncExternalStore(session.store.subscribe, session.store.get);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (session.sharing) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [session]);

  return (
    <main data-phase={state.phase}>
      <h1>didi</h1>
      <SendBody state={state} session={session} />
    </main>
  );
}

function SendBody({ state, session }: { state: SenderState; session: SenderSession }) {
  switch (state.phase) {
    case "idle":
      return <ChooseFile rejected={state.rejected} onFile={(file) => session.choose(file)} />;
    case "registering":
      return (
        <>
          <FileSummary file={state.file} />
          <p className="status">Creating your link…</p>
        </>
      );
    case "waiting":
    case "connecting":
    case "connected":
      return (
        <>
          <FileSummary file={state.file} />
          <ShareLink link={state.link} />
          {state.phase === "waiting" && state.notice !== null && <p className="notice">{noticeText(state.notice)}</p>}
          {!state.online && <p className="notice">Lost contact with the didi server. Reconnecting… The link works again once this page reconnects.</p>}
          <p className="status">{statusText(state)}</p>
          {state.phase === "connected" && <RouteLabel route={state.route} />}
          <p className="hint">Keep this page open. The file goes straight from this browser, so closing the page stops the transfer.</p>
          <button type="button" className="secondary" onClick={() => session.stop()}>
            Stop sharing
          </button>
        </>
      );
    case "failed":
      return (
        <>
          <p className="error" role="alert">
            {errorText(state.error)}
          </p>
          <button type="button" onClick={() => session.stop()}>
            Start over
          </button>
        </>
      );
  }
}

function ChooseFile({ rejected, onFile }: { rejected: FileInfo | null; onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) onFile(file);
  };
  return (
    <section
      className={dragging ? "drop dragging" : "drop"}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <h2>Send a file</h2>
      <p>Up to 2 GB, sent straight from this browser to the recipient’s. Nothing is uploaded.</p>
      <label className="button">
        Choose a file
        <input
          type="file"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file !== undefined) onFile(file);
          }}
        />
      </label>
      <p className="hint">or drop it here</p>
      {rejected !== null && (
        <p className="error" role="alert">
          {rejected.name} is {formatBytes(rejected.size)}. didi sends files up to 2 GB.
        </p>
      )}
    </section>
  );
}

function FileSummary({ file }: { file: FileInfo }) {
  return (
    <p className="file">
      <span className="file-name">{file.name}</span> <span className="file-size">{formatBytes(file.size)}</span>
    </p>
  );
}

function ShareLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="share">
      <input aria-label="Share link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(link).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

function statusText(state: SenderState): string {
  switch (state.phase) {
    case "waiting":
      return "Waiting for the recipient to open the link.";
    case "connecting":
      return "The recipient opened the link. Connecting…";
    case "connected":
      return "Recipient connected. Waiting for them to start receiving.";
    default:
      return "";
  }
}

function noticeText(notice: SenderNotice): string {
  switch (notice) {
    case "recipient-left":
      return "The recipient left before the transfer started.";
    case "connect-failed":
      return "Couldn’t connect directly to the recipient. One of your networks may block direct connections. They can open the link again to retry.";
    case "connection-lost":
      return "The connection to the recipient dropped.";
  }
}

function errorText(error: SenderError): string {
  switch (error) {
    case "server-full":
      return "didi is at capacity right now. Try again in a few minutes.";
    case "server-rejected":
      return "The didi server refused this page’s request. Reload the page and try again.";
  }
}
