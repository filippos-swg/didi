// One WebRTC connection between sender and recipient, carrying one DataChannel.
// The sender is always the offerer, so negotiation never collides.

import type { IceServer, SignalData } from "../../shared/signal-protocol.ts";

export const CONNECT_TIMEOUT_MS = 20_000;
const CHANNEL_LABEL = "didi";

/**
 * How the bytes actually travel, read from the selected ICE candidate pair.
 * "unknown" means the browser did not say, and must never be shown as direct.
 */
export type Route = { kind: "direct"; sameNetwork: boolean } | { kind: "relayed" } | { kind: "unknown" };

export type PeerFailure =
  | "timeout" // no connection within CONNECT_TIMEOUT_MS
  | "failed" // ICE failed, or negotiation broke
  | "closed"; // the DataChannel closed (the other side left, or the connection dropped)

export interface PeerCallbacks {
  sendSignal(data: SignalData): void;
  /** Called at most once, and never after close(). */
  onFailure(reason: PeerFailure, wasConnected: boolean): void;
}

export class PeerLink {
  /** Resolves with the open DataChannel. Rejects if the connection fails first. */
  readonly ready: Promise<RTCDataChannel>;

  private readonly pc: RTCPeerConnection;
  private readonly callbacks: PeerCallbacks;
  private resolveReady!: (channel: RTCDataChannel) => void;
  private rejectReady!: (reason: Error) => void;
  private queue: Promise<void> = Promise.resolve();
  private earlyCandidates: RTCIceCandidateInit[] = [];
  private channel: RTCDataChannel | null = null;
  private connected = false;
  private finished = false;
  private otherPageGone = false;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly onPageHide = () => this.finish(new Error("page closed"));

  constructor(role: "offerer" | "answerer", iceServers: IceServer[], callbacks: PeerCallbacks) {
    this.callbacks = callbacks;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {}); // failures are reported through onFailure

    this.pc = new RTCPeerConnection({ iceServers });
    this.timeout = setTimeout(() => this.fail("timeout"), CONNECT_TIMEOUT_MS);

    this.pc.addEventListener("icecandidate", (event) => {
      const candidate = event.candidate;
      if (candidate === null || candidate.candidate === "") return;
      callbacks.sendSignal({
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        },
      });
    });
    const watchState = () => {
      if (this.pc.connectionState === "failed" || this.pc.iceConnectionState === "failed") this.fail("failed");
      else if (this.otherPageGone && this.pc.iceConnectionState === "disconnected") this.fail("closed");
    };
    this.pc.addEventListener("connectionstatechange", watchState);
    this.pc.addEventListener("iceconnectionstatechange", watchState);
    // Closing the connection on the way out tells the other side at once. Without
    // it, the other side only notices when ICE gives up, about 15 seconds later.
    window.addEventListener("pagehide", this.onPageHide);

    if (role === "offerer") {
      this.adopt(this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
      this.enqueue(async () => {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        callbacks.sendSignal({ description: { type: "offer", sdp: offer.sdp ?? "" } });
      });
    } else {
      this.pc.addEventListener("datachannel", (event) => {
        if (this.channel === null && event.channel.label === CHANNEL_LABEL) this.adopt(event.channel);
      });
    }
  }

  receiveSignal(data: SignalData): void {
    this.enqueue(async () => {
      if ("description" in data) {
        await this.pc.setRemoteDescription(data.description);
        if (data.description.type === "offer") {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.callbacks.sendSignal({ description: { type: "answer", sdp: answer.sdp ?? "" } });
        }
        const early = this.earlyCandidates;
        this.earlyCandidates = [];
        for (const candidate of early) await this.addCandidate(candidate);
      } else if (this.pc.remoteDescription === null) {
        this.earlyCandidates.push(data.candidate);
      } else {
        await this.addCandidate(data.candidate);
      }
    });
  }

  /**
   * The signalling server says the other page's socket closed. On its own that
   * proves nothing, since signalling can drop while the direct connection lives.
   * Combined with ICE losing contact, it means the other page is gone.
   */
  otherPageLeftSignalling(): void {
    this.otherPageGone = true;
    if (this.pc.iceConnectionState === "disconnected") this.fail("closed");
  }

  /** True once the DataChannel has opened. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** The maximum message size both sides agreed on, or null if the browser does not say. */
  maxMessageSize(): number | null {
    const size = this.pc.sctp?.maxMessageSize;
    return size === undefined || size === 0 ? null : size;
  }

  async route(): Promise<Route> {
    try {
      return routeFromStats(await this.pc.getStats());
    } catch {
      return { kind: "unknown" };
    }
  }

  /** Ends the connection at once, without reporting a failure. Anything still queued is lost. */
  close(): void {
    if (this.finished) return;
    this.finish(new Error("closed"));
  }

  /**
   * Ends the connection after everything already queued on the DataChannel has
   * been delivered, so a final message (an abort, or "verified") is not lost.
   */
  closeGracefully(timeoutMs = 5000): void {
    if (this.finished) return;
    const channel = this.channel;
    if (channel === null || channel.readyState !== "open") {
      this.close();
      return;
    }
    this.finished = true; // from here on, the channel closing is expected, not a failure
    clearTimeout(this.timeout);
    this.rejectReady(new Error("closed"));
    const done = () => this.finish(new Error("closed"));
    channel.addEventListener("close", done, { once: true });
    setTimeout(done, timeoutMs);
    channel.close();
  }

  private adopt(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer"; // Firefox defaults to "blob"
    const onOpen = () => {
      if (this.finished) return;
      this.connected = true;
      clearTimeout(this.timeout);
      this.resolveReady(channel);
    };
    if (channel.readyState === "open") onOpen();
    else channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", () => this.fail("closed"));
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // One unusable candidate (say, an unresolvable mDNS name) is not a failure.
    }
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.finished) return;
      try {
        await step();
      } catch {
        this.fail("failed");
      }
    });
  }

  private fail(reason: PeerFailure): void {
    if (this.finished) return;
    this.finish(new Error(reason));
    this.callbacks.onFailure(reason, this.connected);
  }

  private finish(reason: Error): void {
    this.finished = true;
    clearTimeout(this.timeout);
    window.removeEventListener("pagehide", this.onPageHide);
    this.rejectReady(reason);
    if (this.pc.connectionState !== "closed") this.pc.close();
  }
}

type CandidateType = "host" | "srflx" | "prflx" | "relay";

function routeFromStats(stats: RTCStatsReport): Route {
  let pair: RTCIceCandidatePairStats | undefined;
  stats.forEach((report: RTCStats) => {
    if (report.type === "transport") {
      const id = (report as RTCTransportStats).selectedCandidatePairId;
      if (id !== undefined) pair = stats.get(id) as RTCIceCandidatePairStats | undefined;
    }
  });
  if (pair === undefined) {
    // Firefox has no selectedCandidatePairId; it marks the pair instead.
    stats.forEach((report: RTCStats) => {
      const candidatePair = report as RTCIceCandidatePairStats & { selected?: boolean };
      if (report.type === "candidate-pair" && candidatePair.selected === true) pair = candidatePair;
    });
  }
  if (pair === undefined) return { kind: "unknown" };

  const local = candidateType(stats, pair.localCandidateId);
  const remote = candidateType(stats, pair.remoteCandidateId);
  if (local === null || remote === null) return { kind: "unknown" };
  if (local === "relay" || remote === "relay") return { kind: "relayed" };
  return { kind: "direct", sameNetwork: local === "host" && remote === "host" };
}

function candidateType(stats: RTCStatsReport, id: string): CandidateType | null {
  const candidate = stats.get(id) as { candidateType?: unknown } | undefined;
  const type = candidate?.candidateType;
  return type === "host" || type === "srflx" || type === "prflx" || type === "relay" ? type : null;
}
