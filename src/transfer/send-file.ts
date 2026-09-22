// Sends one file over an open DataChannel, one block at a time. Memory held at
// once: the block being sent, the next block being read, and whatever the
// channel has queued (at most BUFFER_HIGH_BYTES plus one chunk).

import {
  BLOCK_BYTES,
  BUFFER_HIGH_BYTES,
  BUFFER_LOW_BYTES,
  MAX_CHUNK_BYTES,
  PROTOCOL_VERSION,
  TransferError,
  WINDOW_BYTES,
  blockCount,
  blockLength,
  parseReceiverMessage,
  sha256,
  toHex,
  type AbortReason,
  type Channel,
  type SenderMessage,
} from "./protocol.ts";

export interface SendCallbacks {
  /** The recipient chose to receive. */
  onAccepted(): void;
  /** Bytes the recipient has verified and committed. */
  onProgress(delivered: number): void;
}

export class FileSender {
  private readonly channel: Channel;
  private readonly file: File;
  private readonly chunkBytes: number;
  private readonly callbacks: SendCallbacks;
  private accepted = false;
  private verifiedRoot: string | null = null;
  private sent = 0;
  private acked = 0;
  private failure: TransferError | null = null;
  private wake: (() => void) | null = null;

  /** @param maxMessageSize the negotiated SCTP limit, if the browser reports one */
  constructor(channel: Channel, file: File, maxMessageSize: number | null, callbacks: SendCallbacks) {
    this.channel = channel;
    this.file = file;
    this.chunkBytes = Math.min(MAX_CHUNK_BYTES, maxMessageSize ?? MAX_CHUNK_BYTES);
    this.callbacks = callbacks;
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;
    channel.addEventListener("message", this.onMessage);
    channel.addEventListener("bufferedamountlow", this.poke);
    channel.addEventListener("close", this.onClose);
  }

  /** Offers the file, sends it once accepted, and resolves when the recipient has verified it. */
  async run(): Promise<void> {
    try {
      const { name, size, type, lastModified } = this.file;
      this.send({ t: "meta", v: PROTOCOL_VERSION, blockBytes: BLOCK_BYTES, name, size, type, lastModified });
      await this.until(() => this.accepted);
      this.callbacks.onAccepted();

      const blocks = blockCount(size);
      const digests = new Uint8Array(blocks * 32);
      let next = blocks > 0 ? this.read(0) : null;
      for (let index = 0; index < blocks; index++) {
        const block = await (next as Promise<ArrayBuffer>);
        next = index + 1 < blocks ? this.read(index + 1) : null; // read ahead while this block goes out
        const digest = await sha256(block);
        digests.set(digest, index * 32);

        await this.until(() => this.sent - this.acked + block.byteLength <= WINDOW_BYTES);
        for (let offset = 0; offset < block.byteLength; offset += this.chunkBytes) {
          await this.until(() => this.channel.bufferedAmount <= BUFFER_HIGH_BYTES);
          this.send(block.slice(offset, offset + this.chunkBytes));
        }
        this.sent += block.byteLength;
        this.send({ t: "block", index, hash: toHex(digest) });
      }

      const root = toHex(await sha256(digests));
      this.send({ t: "done", root });
      await this.until(() => this.verifiedRoot !== null);
      if (this.verifiedRoot !== root) throw this.abort("integrity");
    } finally {
      this.detach();
    }
  }

  /** The connection is gone. An abort the recipient sent first is still the reported reason. */
  connectionLost(): void {
    this.fail(new TransferError("channel-closed", false));
  }

  /** Stops the transfer and tells the recipient. Close the channel gracefully afterwards so the message arrives. */
  cancel(): void {
    this.abort("cancelled");
  }

  private read(index: number): Promise<ArrayBuffer> {
    const start = index * BLOCK_BYTES;
    const reading = this.file
      .slice(start, start + blockLength(this.file.size, index))
      .arrayBuffer()
      .catch(() => {
        // Chrome raises NotReadableError if the file changed or moved after it was chosen.
        throw this.abort("file-unreadable");
      });
    reading.catch(() => {}); // a read-ahead that fails is reported when awaited
    return reading;
  }

  private send(data: SenderMessage | ArrayBuffer): void {
    if (this.failure !== null) throw this.failure;
    try {
      if (data instanceof ArrayBuffer) this.channel.send(data);
      else this.channel.send(JSON.stringify(data));
    } catch {
      throw this.fail(new TransferError("channel-closed", false));
    }
  }

  /** Waits for a condition that only changes when a channel event arrives. */
  private async until(condition: () => boolean): Promise<void> {
    for (;;) {
      if (this.failure !== null) throw this.failure;
      if (condition()) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private readonly poke = (): void => {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  };

  private readonly onMessage = (event: Event): void => {
    const data: unknown = (event as MessageEvent).data;
    const message = typeof data === "string" ? parseReceiverMessage(data) : null;
    if (message === null) {
      this.abort("protocol");
      return;
    }
    switch (message.t) {
      case "accept":
        if (this.accepted) this.abort("protocol");
        this.accepted = true;
        break;
      case "ack":
        if (message.bytes < this.acked || message.bytes > this.sent) {
          this.abort("protocol");
          break;
        }
        this.acked = message.bytes;
        this.callbacks.onProgress(message.bytes);
        break;
      case "verified":
        this.verifiedRoot = message.root;
        break;
      case "abort":
        this.fail(new TransferError(message.reason, true));
        break;
    }
    this.poke();
  };

  private readonly onClose = (): void => this.connectionLost();

  /** Fails here and tells the recipient why. */
  private abort(reason: AbortReason): TransferError {
    if (this.failure !== null) return this.failure;
    const error = this.fail(new TransferError(reason, false));
    try {
      this.channel.send(JSON.stringify({ t: "abort", reason } satisfies SenderMessage));
    } catch {
      // the channel is already gone; nothing to tell
    }
    return error;
  }

  private fail(error: TransferError): TransferError {
    this.failure ??= error;
    this.poke();
    return this.failure;
  }

  private detach(): void {
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("bufferedamountlow", this.poke);
    this.channel.removeEventListener("close", this.onClose);
  }
}
