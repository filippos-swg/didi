// Drives one receiving session: joins the link from the URL fragment, connects
// to the sender, and receives the file once the recipient chooses to.

import { isSessionId } from "../../shared/session-id.ts";
import type { IceServer, ServerMessage } from "../../shared/signal-protocol.ts";
import type { ConnectionReport } from "../net/connection-report.ts";
import { PeerLink } from "../net/peer.ts";
import { connectSignal, type SignalConnection } from "../net/signal-client.ts";
import { Store } from "../store.ts";
import { TransferError } from "../transfer/protocol.ts";
import { FileReceiver } from "../transfer/receive-file.ts";
import { MemorySink, canSaveToDisk, chooseDiskSink, type Sink, type SinkResult } from "../transfer/sinks.ts";
import { SpeedMeter, watchForStalls } from "../transfer/speed.ts";
import { initialReceiverState, receiverReducer, type ReceiverError, type ReceiverEvent, type ReceiverState } from "./receiver-state.ts";

interface Attempt {
  readonly peer: PeerLink;
  transfer: FileReceiver | null;
}

export class ReceiverSession {
  readonly store = new Store<ReceiverState, ReceiverEvent>(initialReceiverState, receiverReducer);

  private readonly sessionId: string | null;
  private started = false;
  private signal: SignalConnection | null = null;
  private attempt: Attempt | null = null;

  constructor(fragment: string) {
    const id = fragment.replace(/^#/, "");
    this.sessionId = isSessionId(id) ? id : null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.join();
  }

  retry(): void {
    const before = this.store.get();
    this.store.dispatch({ type: "retry" });
    if (this.store.get() !== before) void this.join();
  }

  /**
   * The recipient chose to receive the file on offer. Call it straight from the
   * click: where the browser can save to disk, this opens the save dialog, and
   * browsers only allow that in response to a click.
   */
  receive(): void {
    const state = this.store.get();
    const attempt = this.attempt;
    const transfer = attempt?.transfer;
    if (state.phase !== "ready" || attempt === null || transfer === null || transfer === undefined) return;

    if (!canSaveToDisk()) {
      this.startReceiving(attempt, transfer, new MemorySink(state.file.type), state.file.size);
      return;
    }
    this.store.dispatch({ type: "choosing" });
    chooseDiskSink(state.file.name).then(
      (sink) => {
        if (this.attempt !== attempt || this.store.get().phase !== "choosing") {
          void sink?.abort();
          return;
        }
        if (sink === null) this.store.dispatch({ type: "choice-cancelled" });
        else this.startReceiving(attempt, transfer, sink, state.file.size);
      },
      (error: unknown) => {
        // The browser refused the dialog or the file. Receiving into memory still works.
        console.warn("didi: saving to disk is unavailable, receiving into memory instead", error);
        if (this.attempt === attempt && this.store.get().phase === "choosing") {
          this.startReceiving(attempt, transfer, new MemorySink(state.file.type), state.file.size);
        }
      },
    );
  }

  private startReceiving(attempt: Attempt, transfer: FileReceiver, sink: Sink, size: number): void {
    const meter = new SpeedMeter();
    this.store.dispatch({ type: "accepted" });
    watchForStalls(
      () => {
        if (this.attempt !== attempt || this.store.get().phase !== "receiving") return undefined;
        return transfer.received >= size ? null : String(transfer.received);
      },
      (seconds) => this.store.dispatch({ type: "stalled", seconds }),
    );
    transfer
      .accept(sink, (received) => {
        if (meter.add(received) || received === size) this.store.dispatch({ type: "progress", received, bytesPerSecond: meter.bytesPerSecond() });
      })
      .then(
        (result) => this.complete(attempt, result),
        () => {}, // reported through transfer.failed
      );
  }

  /** The recipient stopped receiving. The sender is told. */
  cancel(): void {
    this.attempt?.transfer?.cancel();
  }

  private async join(): Promise<void> {
    if (this.sessionId === null) {
      this.store.dispatch({ type: "unavailable", reason: "invalid-link" });
      return;
    }
    let connection: SignalConnection | null = null;
    try {
      connection = await connectSignal(
        (message) => {
          if (this.signal === connection) this.onMessage(message);
        },
        () => {
          if (this.signal === connection) this.onSignalLost();
        },
      );
    } catch {
      this.store.dispatch({ type: "failed", error: "server-unreachable", report: null });
      return;
    }
    this.signal = connection;
    connection.send({ type: "join", sessionId: this.sessionId });
  }

  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "joined":
        this.store.dispatch({ type: "joined" });
        this.connectToSender(message.iceServers);
        return;
      case "signal":
        this.attempt?.peer.receiveSignal(message.data);
        return;
      case "peer-left": {
        const attempt = this.attempt;
        if (attempt === null) return;
        if (attempt.peer.isConnected) attempt.peer.otherPageLeftSignalling();
        else this.fail("sender-left");
        return;
      }
      case "error":
        this.closeSignal();
        if (message.code === "not-found" || message.code === "offline" || message.code === "busy" || message.code === "full") {
          this.store.dispatch({ type: "unavailable", reason: message.code });
        } else {
          this.fail("server-rejected");
        }
        return;
      case "hosting":
      case "peer-joined":
        return; // only sent to senders
    }
  }

  private onSignalLost(): void {
    this.signal = null;
    // A direct connection no longer needs signalling.
    if (this.attempt?.peer.isConnected !== true) this.fail("signalling-lost");
  }

  private connectToSender(iceServers: IceServer[]): void {
    const peer = new PeerLink("answerer", iceServers, {
      sendSignal: (data) => this.signal?.send({ type: "signal", data }),
      onFailure: (reason, wasConnected, report) => {
        if (this.attempt !== attempt) return;
        // Once the channel is open, the transfer knows more (the sender may have said why), so it reports.
        if (attempt.transfer !== null) attempt.transfer.connectionLost();
        else this.fail(wasConnected ? "connection-lost" : reason === "closed" ? "sender-left" : "connect-failed", report);
      },
    });
    const attempt: Attempt = { peer, transfer: null };
    this.attempt = attempt;
    void peer.ready.then(
      async (channel) => {
        const transfer = new FileReceiver(channel);
        attempt.transfer = transfer;
        void transfer.failed.then((error) => {
          if (this.attempt === attempt) this.fail(errorFor(error));
        });
        try {
          const [file, route] = await Promise.all([transfer.meta, peer.route()]);
          if (this.attempt === attempt) this.store.dispatch({ type: "offered", file, route });
        } catch (error) {
          if (this.attempt === attempt) this.fail(errorFor(error));
        }
      },
      () => {},
    );
  }

  private complete(attempt: Attempt, result: SinkResult): void {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    this.store.dispatch({ type: "complete", result });
    attempt.peer.closeGracefully(); // lets "verified" reach the sender
    this.closeSignal();
  }

  private fail(error: ReceiverError, report: ConnectionReport | null = null): void {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.peer.closeGracefully(); // lets a final abort reach the sender
    this.closeSignal(); // frees the one-recipient slot for a retry
    this.store.dispatch({ type: "failed", error, report });
  }

  private closeSignal(): void {
    this.signal?.close();
    this.signal = null;
  }
}

function errorFor(error: unknown): ReceiverError {
  if (!(error instanceof TransferError)) return "transfer-failed";
  switch (error.reason) {
    case "channel-closed":
      return "connection-lost";
    case "cancelled":
      return error.byPeer ? "sender-cancelled" : "cancelled";
    case "file-unreadable":
      return "sender-file-unreadable";
    case "integrity":
      return "integrity-failed";
    case "write-failed":
      return "save-failed";
    case "protocol":
      return "transfer-failed";
  }
}
