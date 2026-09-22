// Drives one sending session: registers the link, keeps it registered through
// signalling drops, connects to whoever opens it, and sends the file.

import { createHostKey } from "../../shared/session-id.ts";
import { CLOSE_SESSION_ENDED, type IceServer, type ServerMessage } from "../../shared/signal-protocol.ts";
import type { ConnectionReport } from "../net/connection-report.ts";
import { PeerLink } from "../net/peer.ts";
import { connectSignal, type SignalConnection } from "../net/signal-client.ts";
import { Store } from "../store.ts";
import { MAX_FILE_BYTES, TransferError } from "../transfer/protocol.ts";
import { FileSender } from "../transfer/send-file.ts";
import { SpeedMeter, watchForStalls } from "../transfer/speed.ts";
import {
  initialSenderState,
  senderReducer,
  type FileInfo,
  type SenderError,
  type SenderEvent,
  type SenderNotice,
  type SenderState,
} from "./sender-state.ts";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/** One attempt to deliver the file to whoever opened the link. */
interface Attempt {
  readonly peer: PeerLink;
  transfer: FileSender | null;
}

export class SenderSession {
  readonly store = new Store<SenderState, SenderEvent>(initialSenderState, senderReducer);

  private active = false;
  private file: File | null = null;
  private hostKey = "";
  private iceServers: IceServer[] = [];
  private signal: SignalConnection | null = null;
  private attempt: Attempt | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** True while a link exists that closing the page would break. */
  get sharing(): boolean {
    return this.active;
  }

  choose(file: File): void {
    if (this.store.get().phase !== "idle") return;
    const info: FileInfo = { name: file.name, size: file.size, type: file.type };
    if (file.size > MAX_FILE_BYTES) {
      this.store.dispatch({ type: "file-too-large", file: info });
      return;
    }
    this.active = true;
    this.file = file;
    this.hostKey = createHostKey(); // a new file always gets a new link
    this.store.dispatch({ type: "file-chosen", file: info });
    void this.openSignal();
  }

  /** Stops sharing. The link stops working, and a recipient mid-transfer is told why. */
  stop(): void {
    const attempt = this.attempt;
    const signal = this.signal;
    this.release();
    this.store.dispatch({ type: "reset" });
    attempt?.transfer?.cancel();
    attempt?.peer.closeGracefully(); // the recipient is told why before the connection closes
    signal?.close(CLOSE_SESSION_ENDED);
  }

  private async openSignal(): Promise<void> {
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
      this.store.dispatch({ type: "signal-down" });
      this.scheduleReconnect();
      return;
    }
    if (!this.active) {
      connection.close(CLOSE_SESSION_ENDED);
      return;
    }
    this.signal = connection;
    connection.send({ type: "host", hostKey: this.hostKey });
  }

  private onSignalLost(): void {
    this.signal = null;
    this.store.dispatch({ type: "signal-down" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSignal();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hosting":
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.iceServers = message.iceServers;
        this.store.dispatch({ type: "hosting", link: `${location.origin}/r#${message.sessionId}` });
        return;
      case "peer-joined":
        // After a reclaim the server re-announces a recipient we may already be connected to.
        if (this.attempt === null) this.connectToRecipient();
        return;
      case "peer-left": {
        const attempt = this.attempt;
        if (attempt === null) return;
        if (attempt.peer.isConnected) attempt.peer.otherPageLeftSignalling();
        else this.endAttempt(attempt, "recipient-left");
        return;
      }
      case "signal":
        this.attempt?.peer.receiveSignal(message.data);
        return;
      case "error":
        this.fail(message.code === "full" ? "server-full" : "server-rejected");
        return;
      case "joined":
        return; // only sent to recipients
    }
  }

  private connectToRecipient(): void {
    const peer = new PeerLink("offerer", this.iceServers, {
      sendSignal: (data) => this.signal?.send({ type: "signal", data }),
      onFailure: (reason, wasConnected, report) => {
        if (this.attempt !== attempt) return;
        // A running transfer knows more (the recipient may have said why), so it reports.
        if (attempt.transfer !== null) attempt.transfer.connectionLost();
        else this.endAttempt(attempt, wasConnected ? "connection-lost" : reason === "closed" ? "recipient-left" : "connect-failed", report);
      },
    });
    const attempt: Attempt = { peer, transfer: null };
    this.attempt = attempt;
    this.store.dispatch({ type: "peer-joined" });
    void peer.ready.then(
      async (channel) => {
        const route = await peer.route();
        if (this.attempt !== attempt || this.file === null) return;
        this.store.dispatch({ type: "peer-connected", route });
        this.sendFile(attempt, channel, this.file);
      },
      () => {},
    );
  }

  private sendFile(attempt: Attempt, channel: RTCDataChannel, file: File): void {
    const meter = new SpeedMeter();
    let delivered = 0;
    const transfer = new FileSender(channel, file, attempt.peer.maxMessageSize(), {
      onAccepted: () => {
        this.store.dispatch({ type: "accepted" });
        // Data is moving if acknowledgements arrive or the outgoing queue changes.
        watchForStalls(
          () => {
            if (this.attempt !== attempt || this.store.get().phase !== "sending") return undefined;
            return delivered === file.size ? null : `${delivered}/${channel.bufferedAmount}`;
          },
          (seconds) => this.store.dispatch({ type: "stalled", seconds }),
        );
      },
      onProgress: (bytes) => {
        delivered = bytes;
        if (meter.add(bytes) || bytes === file.size) this.store.dispatch({ type: "progress", delivered: bytes, bytesPerSecond: meter.bytesPerSecond() });
      },
    });
    attempt.transfer = transfer;
    transfer.run().then(
      () => {
        if (this.attempt !== attempt) return;
        // Delivered and verified: the link has done its one job.
        const signal = this.signal;
        this.release();
        this.store.dispatch({ type: "delivered" });
        attempt.peer.closeGracefully();
        signal?.close(CLOSE_SESSION_ENDED);
      },
      (error: unknown) => {
        if (this.attempt !== attempt) return;
        if (error instanceof TransferError && error.reason === "file-unreadable" && !error.byPeer) this.fail("file-unreadable");
        else this.endAttempt(attempt, noticeFor(error));
      },
    );
  }

  /** Ends one attempt; the link stays open for another. */
  private endAttempt(attempt: Attempt, notice: SenderNotice, report: ConnectionReport | null = null): void {
    this.attempt = null;
    this.store.dispatch({ type: "peer-lost", notice, report });
    attempt.peer.closeGracefully(); // lets a final abort reach the recipient
  }

  private fail(error: SenderError): void {
    const attempt = this.attempt;
    const signal = this.signal;
    this.release();
    this.store.dispatch({ type: "fatal", error });
    attempt?.peer.closeGracefully();
    signal?.close(CLOSE_SESSION_ENDED);
  }

  /** Forgets every resource so no callback can act on this session again. Closing is the caller's job. */
  private release(): void {
    this.active = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.attempt = null;
    this.signal = null;
    this.file = null;
  }
}

function noticeFor(error: unknown): SenderNotice {
  if (!(error instanceof TransferError)) return "transfer-failed";
  switch (error.reason) {
    case "channel-closed":
      return "connection-lost";
    case "cancelled":
      return "recipient-cancelled";
    case "integrity":
      return "integrity-failed";
    case "write-failed":
      return "recipient-save-failed";
    case "file-unreadable":
    case "protocol":
      return "transfer-failed";
  }
}
