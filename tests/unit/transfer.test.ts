import assert from "node:assert/strict";
import { test } from "node:test";
import { FileReceiver } from "../../src/transfer/receive-file.ts";
import { FileSender } from "../../src/transfer/send-file.ts";
import { MemorySink, type Sink, type SinkResult } from "../../src/transfer/sinks.ts";
import { BLOCK_BYTES, BUFFER_HIGH_BYTES, MAX_CHUNK_BYTES, TransferError, WINDOW_BYTES } from "../../src/transfer/protocol.ts";
import { channelPair, type FakeChannel, type FakeChannelOptions } from "./fake-channel.ts";

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
  return bytes;
}

function fileOf(bytes: Uint8Array<ArrayBuffer>, name = "data.bin"): File {
  return new File([bytes], name, { type: "application/octet-stream", lastModified: 1_700_000_000_000 });
}

async function blobBytes(result: SinkResult): Promise<Uint8Array> {
  assert.equal(result.kind, "blob");
  assert.ok(result.kind === "blob");
  return new Uint8Array(await result.blob.arrayBuffer());
}

interface Setup {
  sender?: FakeChannelOptions;
  receiver?: FakeChannelOptions;
  sink?: Sink;
  maxMessageSize?: number;
}

function start(file: File, setup: Setup = {}) {
  const [senderChannel, receiverChannel] = channelPair(setup.sender, setup.receiver);
  const progress: number[] = [];
  const sender = new FileSender(senderChannel, file, setup.maxMessageSize ?? null, {
    onAccepted: () => {},
    onProgress: (delivered) => progress.push(delivered),
  });
  const receiver = new FileReceiver(receiverChannel);
  const sending = sender.run();
  sending.catch(() => {});
  return { sender, receiver, sending, senderChannel, receiverChannel, progress };
}

function isTransferError(reason: TransferError["reason"], byPeer: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof TransferError, `expected TransferError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    assert.equal(error.byPeer, byPeer);
    return true;
  };
}

test("files of awkward sizes arrive byte for byte", async (t) => {
  for (const size of [0, 1, 1000, BLOCK_BYTES - 1, BLOCK_BYTES, BLOCK_BYTES + 1, 3 * BLOCK_BYTES + 12_345]) {
    await t.test(`${size} bytes`, async () => {
      const bytes = randomBytes(size);
      const { receiver, sending, progress } = start(fileOf(bytes, "report.pdf"));
      const meta = await receiver.meta;
      assert.deepEqual(meta, { name: "report.pdf", size, type: "application/octet-stream", lastModified: 1_700_000_000_000 });
      const result = await receiver.accept(new MemorySink(meta.type), () => {});
      await sending;
      assert.deepEqual(await blobBytes(result), bytes);
      assert.equal(progress.at(-1) ?? 0, size);
    });
  }
});

test("the sender never has more than the window unacknowledged, even with a slow disk", async () => {
  const bytes = randomBytes(40 * 1024 * 1024);
  let written = 0;
  const slowSink: Sink = {
    async write(block) {
      await new Promise((resolve) => setTimeout(resolve, 3));
      written += block.byteLength;
    },
    close: () => Promise.resolve({ kind: "file", name: "slow" }),
    abort: () => Promise.resolve(),
  };
  const { receiver, sending, senderChannel } = start(fileOf(bytes), { sender: { bytesPerTick: 8 * 1024 * 1024 } });
  let maxInFlight = 0;
  senderChannel.onSendBinary = () => {
    maxInFlight = Math.max(maxInFlight, senderChannel.binarySent - written);
  };
  await receiver.meta;
  await receiver.accept(slowSink, () => {});
  await sending;
  assert.equal(written, bytes.byteLength);
  assert.ok(maxInFlight <= WINDOW_BYTES, `in flight reached ${maxInFlight}`);
  assert.ok(maxInFlight > WINDOW_BYTES / 2, "the test should actually exercise the window");
});

test("the sender pauses when the channel's queue is full", async () => {
  const bytes = randomBytes(24 * 1024 * 1024);
  const { receiver, sending, senderChannel } = start(fileOf(bytes), { sender: { bytesPerTick: 256 * 1024 } });
  await receiver.meta;
  const result = await receiver.accept(new MemorySink(""), () => {});
  await sending;
  assert.deepEqual(await blobBytes(result), bytes);
  assert.ok(senderChannel.maxBuffered <= BUFFER_HIGH_BYTES + MAX_CHUNK_BYTES + 1024, `buffered reached ${senderChannel.maxBuffered}`);
  assert.ok(senderChannel.maxBuffered > BUFFER_HIGH_BYTES / 2, "the test should actually exercise backpressure");
});

test("chunks respect the negotiated maximum message size", async () => {
  const sizes: number[] = [];
  const bytes = randomBytes(BLOCK_BYTES + 5);
  const { receiver, sending } = start(fileOf(bytes), {
    maxMessageSize: 16 * 1024,
    sender: {
      tamper: (data) => {
        sizes.push(data.byteLength);
        return data;
      },
    },
  });
  await receiver.meta;
  const result = await receiver.accept(new MemorySink(""), () => {});
  await sending;
  assert.deepEqual(await blobBytes(result), bytes);
  assert.equal(Math.max(...sizes), 16 * 1024);
});

test("a corrupted chunk fails the transfer on both sides", async () => {
  const { receiver, sending } = start(fileOf(randomBytes(3 * BLOCK_BYTES)), {
    sender: {
      tamper: (data, index) => {
        if (index === 20) {
          const view = new Uint8Array(data);
          view[100] = (view[100] ?? 0) ^ 0xff;
        }
        return data;
      },
    },
  });
  await receiver.meta;
  await assert.rejects(receiver.accept(new MemorySink(""), () => {}), isTransferError("integrity", false));
  await assert.rejects(sending, isTransferError("integrity", true));
});

test("the recipient cancelling mid-transfer stops the sender", async () => {
  const { receiver, sending } = start(fileOf(randomBytes(8 * BLOCK_BYTES)), { sender: { bytesPerTick: 128 * 1024 } });
  await receiver.meta;
  const receiving = receiver.accept(new MemorySink(""), (committed) => {
    if (committed === BLOCK_BYTES) void receiver.cancel();
  });
  await assert.rejects(receiving, isTransferError("cancelled", false));
  await assert.rejects(sending, isTransferError("cancelled", true));
});

test("the sender cancelling before the recipient accepts is reported to the recipient", async () => {
  const { sender, receiver, sending } = start(fileOf(randomBytes(10)));
  await receiver.meta;
  await sender.cancel();
  await assert.rejects(sending, isTransferError("cancelled", false));
  await assert.rejects(receiver.accept(new MemorySink(""), () => {}), isTransferError("cancelled", true));
});

test("the channel closing mid-transfer fails both sides", async () => {
  let channel: FakeChannel | null = null;
  const { receiver, sending, senderChannel } = start(fileOf(randomBytes(8 * BLOCK_BYTES)), { sender: { bytesPerTick: 128 * 1024 } });
  channel = senderChannel;
  await receiver.meta;
  const receiving = receiver.accept(new MemorySink(""), (committed) => {
    if (committed === 2 * BLOCK_BYTES) channel?.close();
  });
  await assert.rejects(receiving, isTransferError("channel-closed", false));
  await assert.rejects(sending, isTransferError("channel-closed", false));
});

test("a file that becomes unreadable is reported to the recipient", async () => {
  const file = fileOf(randomBytes(3 * BLOCK_BYTES));
  const realSlice = file.slice.bind(file);
  let reads = 0;
  file.slice = (start?: number, end?: number) => {
    reads++;
    if (reads < 2) return realSlice(start, end);
    return { arrayBuffer: () => Promise.reject(new DOMException("the file changed", "NotReadableError")) } as unknown as Blob;
  };
  const { receiver, sending } = start(file);
  await receiver.meta;
  await assert.rejects(receiver.accept(new MemorySink(""), () => {}), isTransferError("file-unreadable", true));
  await assert.rejects(sending, isTransferError("file-unreadable", false));
});

test("a failing disk on the recipient's side is reported to the sender", async () => {
  const failingSink: Sink = {
    write: () => Promise.reject(new DOMException("disk full", "QuotaExceededError")),
    close: () => Promise.resolve({ kind: "file", name: "x" }),
    abort: () => Promise.resolve(),
  };
  const { receiver, sending } = start(fileOf(randomBytes(2 * BLOCK_BYTES)));
  await receiver.meta;
  await assert.rejects(receiver.accept(failingSink, () => {}), isTransferError("write-failed", false));
  await assert.rejects(sending, isTransferError("write-failed", true));
});

test("file bytes before the recipient accepts are a protocol violation", async () => {
  const [senderChannel, receiverChannel] = channelPair();
  const receiver = new FileReceiver(receiverChannel);
  senderChannel.send(new ArrayBuffer(10));
  await assert.rejects(receiver.meta, isTransferError("protocol", false));
});

test("an acknowledgement for bytes never sent is a protocol violation", async () => {
  const [senderChannel, receiverChannel] = channelPair();
  const sender = new FileSender(senderChannel, fileOf(randomBytes(10)), null, { onAccepted: () => {}, onProgress: () => {} });
  const sending = sender.run();
  receiverChannel.send(JSON.stringify({ t: "accept" }));
  receiverChannel.send(JSON.stringify({ t: "ack", bytes: 5_000_000 }));
  await assert.rejects(sending, isTransferError("protocol", false));
});
