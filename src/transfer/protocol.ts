// The file-transfer protocol spoken over the DataChannel. See docs/ARCHITECTURE.md,
// "Transfer protocol". Control messages are JSON strings; file bytes are binary.
//
//   sender                              recipient
//   meta ─────────────────────────────▶ (shows name and size)
//        ◀───────────────────────────── accept
//   chunks of block 0, then block 0 ──▶ (checks hash, writes, acks)
//        ◀───────────────────────────── ack (bytes committed so far)
//   …
//   done (root hash) ─────────────────▶ (checks root, closes the file)
//        ◀───────────────────────────── verified (root hash)
//
// Either side may send abort at any point.

export const PROTOCOL_VERSION = 1;

/** Product limit for v0.1: 2 GB, meaning 2 GiB. See docs/DECISIONS.md. */
export const MAX_FILE_BYTES = 2 * 1024 ** 3;

/** Unit of hashing, writing and acknowledgement. */
export const BLOCK_BYTES = 1024 * 1024;

/** Largest binary message, further capped by the negotiated SCTP maximum. */
export const MAX_CHUNK_BYTES = 64 * 1024;

/**
 * Stop sending while more than this is queued in the DataChannel. Kept small
 * because control messages (a block hash, an abort) wait behind whatever is
 * queued: at 1 MB/s, 1 MiB is a second. Throughput is unaffected, since the
 * browser keeps the network busy as long as the queue never empties (measured:
 * 1 MiB and 8 MiB performed the same). Chrome fails send() past 16 MiB.
 */
export const BUFFER_HIGH_BYTES = 1024 * 1024;

/** Refill when the queue drains below this (bufferedamountlow). */
export const BUFFER_LOW_BYTES = 256 * 1024;

/** At most this many bytes sent but not yet committed by the recipient. */
export const WINDOW_BYTES = 16 * 1024 * 1024;

export type AbortReason =
  | "cancelled" // the person on that side stopped
  | "file-unreadable" // the sender's file could not be read (moved, changed or deleted)
  | "integrity" // a block or the root hash did not match
  | "write-failed" // the recipient could not save (disk full, permission revoked)
  | "protocol"; // a message arrived that the protocol does not allow

export interface FileMeta {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export type SenderMessage =
  | ({ t: "meta"; v: typeof PROTOCOL_VERSION; blockBytes: number } & FileMeta)
  | { t: "block"; index: number; hash: string }
  | { t: "done"; root: string }
  | { t: "abort"; reason: AbortReason };

export type ReceiverMessage =
  | { t: "accept" }
  | { t: "ack"; bytes: number }
  | { t: "verified"; root: string }
  | { t: "abort"; reason: AbortReason };

const ABORT_REASONS: readonly AbortReason[] = ["cancelled", "file-unreadable", "integrity", "write-failed", "protocol"];
const HASH_PATTERN = /^[0-9a-f]{64}$/;

type Obj = Record<string, unknown>;

function parseObject(text: string): Obj | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
  } catch {
    return null;
  }
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function parseAbort(message: Obj): { t: "abort"; reason: AbortReason } | null {
  const reason = ABORT_REASONS.find((known) => known === message.reason);
  return reason === undefined ? null : { t: "abort", reason };
}

export function parseSenderMessage(text: string): SenderMessage | null {
  const message = parseObject(text);
  if (message === null) return null;
  switch (message.t) {
    case "meta": {
      const { name, size, type, lastModified } = message;
      if (message.v !== PROTOCOL_VERSION || message.blockBytes !== BLOCK_BYTES) return null;
      if (typeof name !== "string" || name.length === 0 || name.length > 1024) return null;
      if (!isCount(size, MAX_FILE_BYTES) || typeof type !== "string" || type.length > 256) return null;
      if (typeof lastModified !== "number" || !Number.isFinite(lastModified)) return null;
      return { t: "meta", v: PROTOCOL_VERSION, blockBytes: BLOCK_BYTES, name, size, type, lastModified };
    }
    case "block":
      return isCount(message.index, MAX_FILE_BYTES / BLOCK_BYTES) && isHash(message.hash) ? { t: "block", index: message.index, hash: message.hash } : null;
    case "done":
      return isHash(message.root) ? { t: "done", root: message.root } : null;
    case "abort":
      return parseAbort(message);
    default:
      return null;
  }
}

export function parseReceiverMessage(text: string): ReceiverMessage | null {
  const message = parseObject(text);
  if (message === null) return null;
  switch (message.t) {
    case "accept":
      return { t: "accept" };
    case "ack":
      return isCount(message.bytes, MAX_FILE_BYTES) ? { t: "ack", bytes: message.bytes } : null;
    case "verified":
      return isHash(message.root) ? { t: "verified", root: message.root } : null;
    case "abort":
      return parseAbort(message);
    default:
      return null;
  }
}

/** The part of RTCDataChannel the transfer engine uses. A fake implements it in tests. */
export interface Channel {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string): void;
  send(data: ArrayBuffer): void;
  /** Graceful: messages already queued are delivered before the channel closes. */
  close(): void;
  addEventListener(type: "message" | "bufferedamountlow" | "close", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "bufferedamountlow" | "close", listener: (event: Event) => void): void;
}

/** Why a transfer ended without being verified. */
export class TransferError extends Error {
  readonly reason: AbortReason | "channel-closed";
  /** True if the other side reported the reason; false if it happened here. */
  readonly byPeer: boolean;

  constructor(reason: AbortReason | "channel-closed", byPeer: boolean) {
    super(`transfer ended: ${reason}${byPeer ? " (reported by peer)" : ""}`);
    this.reason = reason;
    this.byPeer = byPeer;
  }
}

export function blockCount(size: number): number {
  return Math.ceil(size / BLOCK_BYTES);
}

export function blockLength(size: number, index: number): number {
  return Math.min(BLOCK_BYTES, size - index * BLOCK_BYTES);
}

export async function sha256(data: BufferSource): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
