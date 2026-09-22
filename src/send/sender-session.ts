// Drives one sending session: registers the link, keeps it registered through
// signalling drops, and connects to whoever opens it.

import { createHostKey } from "../../shared/session-id.ts";
import { CLOSE_SESSION_ENDED, type IceServer, type ServerMessage } from "../../shared/signal-protocol.ts";
import { PeerLink } from "../net/peer.ts";
import { connectSignal, type SignalConnection } from "../net/signal-client.ts";
import { Store } from "../store.ts";
import { MAX_FILE_BYTES } from "../transfer/protocol.ts";
import { initialSenderState, senderReducer, type FileInfo, type SenderError, type SenderEvent, type SenderState } from "./sender-state.ts";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

export class SenderSession {
  readonly store = new Store<SenderState, SenderEvent>(initialSenderState, senderReducer);

  private active = false;
  private hostKey = "";
  private iceServers: IceServer[] = [];
  private signal: SignalConnection | null = null;
  private peer: PeerLink | null = null;
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
    this.hostKey = createHostKey(); // a new file always gets a new link
    this.store.dispatch({ type: "file-chosen", file: info });
    void this.openSignal();
  }

  /** Stops sharing. The link stops working immediately. */
  stop(): void {
    this.teardown();
    this.store.dispatch({ type: "reset" });
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
        if (this.peer === null) this.connectToRecipient();
        return;
      case "peer-left":
        if (this.peer === null) return;
        if (this.peer.isConnected) {
          this.peer.otherPageLeftSignalling();
        } else {
          this.peer.close();
          this.peer = null;
          this.store.dispatch({ type: "peer-lost", notice: "recipient-left" });
        }
        return;
      case "signal":
        this.peer?.receiveSignal(message.data);
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
      onFailure: (reason, wasConnected) => {
        if (this.peer !== peer) return;
        this.peer = null;
        const notice = wasConnected ? "connection-lost" : reason === "closed" ? "recipient-left" : "connect-failed";
        this.store.dispatch({ type: "peer-lost", notice });
      },
    });
    this.peer = peer;
    this.store.dispatch({ type: "peer-joined" });
    void peer.ready.then(
      async () => {
        const route = await peer.route();
        if (this.peer === peer) this.store.dispatch({ type: "peer-connected", route });
      },
      () => {},
    );
  }

  private fail(error: SenderError): void {
    this.teardown();
    this.store.dispatch({ type: "fatal", error });
  }

  private teardown(): void {
    this.active = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.peer?.close();
    this.peer = null;
    this.signal?.close(CLOSE_SESSION_ENDED);
    this.signal = null;
  }
}
