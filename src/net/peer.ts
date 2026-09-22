// One WebRTC connection between sender and recipient, carrying one DataChannel.
// The sender is always the offerer, so negotiation never collides.

import type { IceServer, SignalData } from "../../shared/signal-protocol.ts";
import { candidateKind, emptyCounts, publicAddress, type ConnectionReport } from "./connection-report.ts";

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
  /**
   * Called at most once, and never after close(). A connection that never
   * opened comes with a report of what was tried.
   */
  onFailure(reason: PeerFailure, wasConnected: boolean, report: ConnectionReport | null): void;
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
  private readonly startedAt = performance.now();
  private readonly localCandidates = emptyCounts();
  private readonly remoteCandidates = emptyCounts();
  // Kept only to tell whether both sides share one; never reported or shown.
  private readonly localPublicAddresses = new Set<string>();
  private readonly remotePublicAddresses = new Set<string>();
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
      const kind = candidateKind(candidate.candidate);
      if (kind !== null) this.localCandidates[kind]++;
      const address = publicAddress(candidate.candidate);
      if (address !== null) this.localPublicAddresses.add(address);
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
    if ("candidate" in data) {
      const kind = candidateKind(data.candidate.candidate);
      if (kind !== null) this.remoteCandidates[kind]++;
      const address = publicAddress(data.candidate.candidate);
      if (address !== null) this.remotePublicAddresses.add(address);
    }
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
  closeGracefully(timeoutMs = 10_000): void {
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
    const wasConnected = this.connected;
    if (wasConnected || reason === "closed") {
      this.finish(new Error(reason));
      this.callbacks.onFailure(reason, wasConnected, null);
      return;
    }
    // Never connected: read what was tried before closing, so the failure can explain itself.
    this.finished = true;
    clearTimeout(this.timeout);
    this.rejectReady(new Error(reason));
    void this.report(reason).then((report) => {
      this.finish(new Error(reason));
      this.callbacks.onFailure(reason, false, report);
    });
  }

  private async report(ending: "timeout" | "failed"): Promise<ConnectionReport> {
    let pairs: ConnectionReport["pairs"] = null;
    try {
      const stats = await this.pc.getStats();
      pairs = { tried: 0, succeeded: 0, failed: 0 };
      const counted = pairs;
      stats.forEach((report: RTCStats) => {
        if (report.type !== "candidate-pair") return;
        const state = (report as RTCIceCandidatePairStats).state;
        counted.tried++;
        if (state === "succeeded") counted.succeeded++;
        if (state === "failed") counted.failed++;
      });
    } catch {
      // the browser would not say
    }
    return {
      ending,
      seconds: Math.round((performance.now() - this.startedAt) / 1000),
      local: { ...this.localCandidates },
      remote: { ...this.remoteCandidates },
      pairs,
      samePublicAddress: [...this.localPublicAddresses].some((address) => this.remotePublicAddresses.has(address)),
    };
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

  const local = candidateStats(stats, pair.localCandidateId);
  const remote = candidateStats(stats, pair.remoteCandidateId);
  if (local === null || remote === null) return { kind: "unknown" };
  if (local.type === "relay" || remote.type === "relay") return { kind: "relayed" };

  // A remote address first seen in a connectivity check (prflx) is often a local
  // address that simply arrived before its candidate message did. It is on this
  // network if it is a private address, or an IPv6 address in one of our subnets.
  const ownPrefixes = new Set<string>();
  stats.forEach((report: RTCStats) => {
    const candidate = report as { candidateType?: unknown; address?: unknown };
    if (report.type === "local-candidate" && candidate.candidateType === "host" && typeof candidate.address === "string") {
      const prefix = ipv6Prefix64(candidate.address);
      if (prefix !== null) ownPrefixes.add(prefix);
    }
  });
  const remotePrefix = ipv6Prefix64(remote.address);
  const remoteIsLocal =
    remote.type === "host" ||
    (remote.type === "prflx" && (isPrivateAddress(remote.address) || (remotePrefix !== null && ownPrefixes.has(remotePrefix))));
  return { kind: "direct", sameNetwork: local.type === "host" && remoteIsLocal };
}

/** The first 64 bits of an IPv6 address (its subnet), normalised; null for anything else. */
export function ipv6Prefix64(address: string): string | null {
  const bare = address.replace(/%.*$/, ""); // drop a zone such as %en0
  if (!bare.includes(":") || bare.includes(".")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" && halves[1] !== undefined ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  return groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":");
}

function candidateStats(stats: RTCStatsReport, id: string): { type: CandidateType; address: string } | null {
  const candidate = stats.get(id) as { candidateType?: unknown; address?: unknown } | undefined;
  const type = candidate?.candidateType;
  if (type !== "host" && type !== "srflx" && type !== "prflx" && type !== "relay") return null;
  return { type, address: typeof candidate?.address === "string" ? candidate.address : "" };
}

/** Addresses that only exist inside a local network. Carrier-grade NAT (100.64/10) is not one. */
export function isPrivateAddress(address: string): boolean {
  if (address.endsWith(".local")) return true; // an mDNS name for a host on this network
  if (/^(10|127)\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
  const lower = address.toLowerCase();
  return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}
