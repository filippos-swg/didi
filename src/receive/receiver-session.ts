// Drives one receiving session: joins the link from the URL fragment and
// connects to the sender.

import { isSessionId } from "../../shared/session-id.ts";
import type { IceServer, ServerMessage } from "../../shared/signal-protocol.ts";
import { PeerLink } from "../net/peer.ts";
import { connectSignal, type SignalConnection } from "../net/signal-client.ts";
import { Store } from "../store.ts";
import { initialReceiverState, receiverReducer, type ReceiverError, type ReceiverEvent, type ReceiverState } from "./receiver-state.ts";

export class ReceiverSession {
  readonly store = new Store<ReceiverState, ReceiverEvent>(initialReceiverState, receiverReducer);

  private readonly sessionId: string | null;
  private started = false;
  private signal: SignalConnection | null = null;
  private peer: PeerLink | null = null;

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
      this.store.dispatch({ type: "failed", error: "server-unreachable" });
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
        this.peer?.receiveSignal(message.data);
        return;
      case "peer-left":
        if (this.peer === null) return;
        if (this.peer.isConnected) this.peer.otherPageLeftSignalling();
        else this.fail("sender-left");
        return;
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
    if (this.peer?.isConnected !== true) this.fail("signalling-lost");
  }

  private connectToSender(iceServers: IceServer[]): void {
    const peer = new PeerLink("answerer", iceServers, {
      sendSignal: (data) => this.signal?.send({ type: "signal", data }),
      onFailure: (reason, wasConnected) => {
        if (this.peer !== peer) return;
        this.peer = null;
        this.fail(wasConnected ? "connection-lost" : reason === "closed" ? "sender-left" : "connect-failed");
      },
    });
    this.peer = peer;
    void peer.ready.then(
      async () => {
        const route = await peer.route();
        if (this.peer === peer) this.store.dispatch({ type: "peer-connected", route });
      },
      () => {},
    );
  }

  private fail(error: ReceiverError): void {
    this.peer?.close();
    this.peer = null;
    this.closeSignal(); // frees the one-recipient slot for a retry
    this.store.dispatch({ type: "failed", error });
  }

  private closeSignal(): void {
    this.signal?.close();
    this.signal = null;
  }
}
