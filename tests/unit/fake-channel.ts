// A pair of in-memory DataChannels for testing the transfer engine in Node.
// Messages are delivered asynchronously, a limited number of bytes per tick, so
// bufferedAmount rises and falls the way a real channel's does.

import type { Channel } from "../../src/transfer/protocol.ts";

const CHROME_SEND_QUEUE_LIMIT = 16 * 1024 * 1024;

export interface FakeChannelOptions {
  /** Bytes delivered per event-loop turn. */
  bytesPerTick?: number;
  /** Called on each binary message in transit; may return a modified copy. */
  tamper?: (data: ArrayBuffer, index: number) => ArrayBuffer;
}

export class FakeChannel extends EventTarget implements Channel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  /** Largest bufferedAmount seen, for asserting backpressure. */
  maxBuffered = 0;
  /** Binary bytes this side has sent. */
  binarySent = 0;
  onSendBinary: (() => void) | null = null;

  peer!: FakeChannel;
  private readonly queue: (string | ArrayBuffer)[] = [];
  private scheduled = false;
  private binaryCount = 0;
  private readonly options: FakeChannelOptions;

  constructor(options: FakeChannelOptions = {}) {
    super();
    this.options = options;
  }

  send(data: string): void;
  send(data: ArrayBuffer): void;
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") throw new DOMException("channel is not open", "InvalidStateError");
    const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (this.bufferedAmount + size > CHROME_SEND_QUEUE_LIMIT) throw new DOMException("send queue is full", "OperationError");
    if (data instanceof ArrayBuffer) {
      this.binarySent += data.byteLength;
      this.onSendBinary?.();
      const tamper = this.options.tamper;
      data = tamper === undefined ? data.slice(0) : tamper(data.slice(0), this.binaryCount);
      this.binaryCount++;
    }
    this.bufferedAmount += size;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    this.queue.push(data);
    this.schedule();
  }

  close(): void {
    if (this.readyState === "closed") return;
    for (const side of [this, this.peer]) {
      side.readyState = "closed";
      setTimeout(() => side.dispatchEvent(new Event("close")), 0);
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.scheduled = false;
    if (this.readyState !== "open") return;
    let budget = this.options.bytesPerTick ?? 1024 * 1024;
    while (this.queue.length > 0 && budget > 0) {
      const data = this.queue.shift() as string | ArrayBuffer;
      const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
      budget -= size;
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      this.peer.dispatchEvent(new MessageEvent("message", { data }));
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event("bufferedamountlow"));
      }
    }
    if (this.queue.length > 0) this.schedule();
  }
}

export function channelPair(senderOptions: FakeChannelOptions = {}, receiverOptions: FakeChannelOptions = {}): [FakeChannel, FakeChannel] {
  const a = new FakeChannel(senderOptions);
  const b = new FakeChannel(receiverOptions);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
