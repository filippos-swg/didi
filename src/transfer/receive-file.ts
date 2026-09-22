// Receives one file over an open DataChannel. Each block is hashed and compared
// with the sender's hash before it is written; nothing unverified reaches the sink.

import {
  TransferError,
  blockCount,
  blockLength,
  parseSenderMessage,
  sha256,
  toHex,
  type AbortReason,
  type Channel,
  type FileMeta,
  type ReceiverMessage,
  type SenderMessage,
} from "./protocol.ts";
import type { Sink, SinkResult } from "./sinks.ts";

type Incoming = string | ArrayBuffer;

export class FileReceiver {
  /** Resolves with the sender's description of the file. */
  readonly meta: Promise<FileMeta>;

  private readonly channel: Channel;
  private resolveMeta!: (meta: FileMeta) => void;
  private rejectMeta!: (error: TransferError) => void;
  private file: FileMeta | null = null;
  private sink: Sink | null = null;
  private onProgress: (committed: number) => void = () => {};
  private resolveDone: ((result: SinkResult) => void) | null = null;
  private rejectDone: ((error: TransferError) => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private failure: TransferError | null = null;
  private finished = false;

  private index = 0;
  private block: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private filled = 0;
  private committed = 0;
  private digests = new Uint8Array(0);

  constructor(channel: Channel) {
    this.channel = channel;
    this.meta = new Promise((resolve, reject) => {
      this.resolveMeta = resolve;
      this.rejectMeta = reject;
    });
    this.meta.catch(() => {});
    channel.addEventListener("message", this.onMessage);
    channel.addEventListener("close", this.onClose);
  }

  /**
   * Tells the sender to start and writes the file to the sink. Resolves once the
   * whole file is verified and the sink is closed.
   */
  accept(sink: Sink, onProgress: (committed: number) => void): Promise<SinkResult> {
    if (this.file === null || this.sink !== null) return Promise.reject(new Error("accept() needs the file description, once"));
    if (this.failure !== null) return Promise.reject(this.failure);
    this.sink = sink;
    this.onProgress = onProgress;
    const done = new Promise<SinkResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.startBlock();
    this.send({ t: "accept" });
    return done;
  }

  /** True between accept() and the transfer ending. While true, this object reports how the transfer ended. */
  get receiving(): boolean {
    return this.sink !== null && !this.finished;
  }

  /**
   * The connection is gone. Handled after every message that already arrived, so
   * a final abort from the sender is reported rather than the bare disconnect.
   */
  connectionLost(): void {
    this.queue = this.queue.then(() => this.fail(new TransferError("channel-closed", false)));
  }

  /** Stops receiving and tells the sender. */
  cancel(): void {
    this.abort("cancelled");
  }

  private readonly onMessage = (event: Event): void => {
    const data: unknown = (event as MessageEvent).data;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
      this.abort("protocol");
      return;
    }
    // Hashing and writing are asynchronous; handle messages strictly in order.
    this.queue = this.queue.then(() => (this.finished ? undefined : this.handle(data)));
  };

  private readonly onClose = (): void => this.connectionLost();

  private async handle(data: Incoming): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.receiveBytes(data);
      return;
    }
    const message = parseSenderMessage(data);
    if (message === null) return void this.abort("protocol");
    switch (message.t) {
      case "meta":
        return this.receiveMeta(message);
      case "block":
        return this.receiveBlockEnd(message.index, message.hash);
      case "done":
        return this.receiveDone(message.root);
      case "abort":
        return void this.fail(new TransferError(message.reason, true));
    }
  }

  private receiveMeta(message: Extract<SenderMessage, { t: "meta" }>): void {
    if (this.file !== null) return void this.abort("protocol");
    const { name, size, type, lastModified } = message;
    this.file = { name, size, type, lastModified };
    this.digests = new Uint8Array(blockCount(size) * 32);
    this.resolveMeta(this.file);
  }

  private receiveBytes(bytes: ArrayBuffer): void {
    if (this.sink === null || this.filled + bytes.byteLength > this.block.byteLength) return void this.abort("protocol");
    this.block.set(new Uint8Array(bytes), this.filled);
    this.filled += bytes.byteLength;
  }

  private async receiveBlockEnd(index: number, hash: string): Promise<void> {
    if (this.sink === null || index !== this.index || this.filled !== this.block.byteLength) return void this.abort("protocol");
    const digest = await sha256(this.block);
    if (toHex(digest) !== hash) return void this.abort("integrity");
    this.digests.set(digest, index * 32);
    try {
      await this.sink.write(this.block);
    } catch {
      return void this.abort("write-failed");
    }
    this.committed += this.block.byteLength;
    this.index++;
    this.send({ t: "ack", bytes: this.committed });
    this.onProgress(this.committed);
    this.startBlock();
  }

  private async receiveDone(root: string): Promise<void> {
    const file = this.file;
    if (file === null || this.sink === null || this.index !== blockCount(file.size)) return void this.abort("protocol");
    const ours = toHex(await sha256(this.digests));
    if (ours !== root) return void this.abort("integrity");
    let result: SinkResult;
    try {
      result = await this.sink.close();
    } catch {
      return void this.abort("write-failed");
    }
    this.send({ t: "verified", root: ours });
    this.finished = true;
    this.detach();
    this.resolveDone?.(result);
  }

  private startBlock(): void {
    const file = this.file;
    if (file === null || this.index >= blockCount(file.size)) {
      this.block = new Uint8Array(0);
    } else {
      this.block = new Uint8Array(blockLength(file.size, this.index));
    }
    this.filled = 0;
  }

  private send(message: ReceiverMessage): void {
    try {
      this.channel.send(JSON.stringify(message));
    } catch {
      this.fail(new TransferError("channel-closed", false));
    }
  }

  /** Fails here and tells the sender why. */
  private abort(reason: AbortReason): void {
    if (this.finished) return;
    this.send({ t: "abort", reason });
    this.fail(new TransferError(reason, false));
  }

  private fail(error: TransferError): void {
    if (this.finished) return;
    this.finished = true;
    this.failure = error;
    this.detach();
    this.rejectMeta(error);
    this.rejectDone?.(error);
    void this.sink?.abort();
  }

  private detach(): void {
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("close", this.onClose);
  }
}
