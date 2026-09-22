// What a failed connection attempt can say about itself: which kinds of network
// address each browser found, and whether any path between them was tried.
// Counts only; no addresses are recorded or shown.

export type CandidateKind = "host" | "srflx" | "prflx" | "relay";

export type CandidateCounts = Record<CandidateKind, number>;

export interface ConnectionReport {
  ending: "timeout" | "failed";
  seconds: number;
  /** Addresses this browser found. */
  local: CandidateCounts;
  /** Addresses that arrived from the other browser. */
  remote: CandidateCounts;
  /** Address pairs the browser tested, or null if it would not say. */
  pairs: { tried: number; succeeded: number; failed: number } | null;
}

export function emptyCounts(): CandidateCounts {
  return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}

/** Reads the candidate type from an ICE candidate line ("… typ srflx …"). */
export function candidateKind(candidate: string): CandidateKind | null {
  const match = / typ (host|srflx|prflx|relay)(?: |$)/.exec(candidate);
  return match === null ? null : (match[1] as CandidateKind);
}

function total(counts: CandidateCounts): number {
  return counts.host + counts.srflx + counts.prflx + counts.relay;
}

function publicCount(counts: CandidateCounts): number {
  return counts.srflx + counts.prflx;
}

export function describeCounts(counts: CandidateCounts): string {
  return `${counts.host} on its own network, ${publicCount(counts)} public, ${counts.relay} relay`;
}

/** The most likely reason, in plain words, from the point of view of the person reading it. */
export function explain(report: ConnectionReport, other: "sender" | "recipient"): string {
  const theirs = `The ${other}’s browser`;
  if (total(report.remote) === 0) {
    return `No network addresses arrived from the ${other}’s browser. Their network may block WebRTC entirely.`;
  }
  if (publicCount(report.local) === 0 && report.local.relay === 0) {
    return "Your browser couldn’t find its public internet address. Your network may block the traffic direct connections need (UDP).";
  }
  if (publicCount(report.remote) === 0 && report.remote.relay === 0) {
    return `${theirs} couldn’t find its public internet address. Their network may block the traffic direct connections need (UDP).`;
  }
  return "Both browsers found their public addresses, but no path between them worked. A firewall or strict router on one side is blocking direct connections. Only a relay server (TURN) would get through, and didi v0.1 doesn’t use one.";
}
