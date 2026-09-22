// Where verified blocks go on the recipient's side.

export type SinkResult =
  | { kind: "blob"; blob: Blob } // assembled in memory; the recipient saves it
  | { kind: "file"; name: string }; // already written to a file the recipient chose

export interface Sink {
  write(block: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<SinkResult>;
  abort(): Promise<void>;
}

/**
 * Keeps the file as a list of per-block Blobs. Wrapping each block in a Blob as it
 * arrives lets the browser manage the bytes (Chrome can page large blobs to disk)
 * and lets the final Blob reference the parts instead of copying them.
 */
export class MemorySink implements Sink {
  private parts: Blob[] = [];
  private readonly type: string;

  constructor(type: string) {
    this.type = type;
  }

  write(block: Uint8Array<ArrayBuffer>): Promise<void> {
    this.parts.push(new Blob([block]));
    return Promise.resolve();
  }

  close(): Promise<SinkResult> {
    const blob = new Blob(this.parts, { type: this.type });
    this.parts = [];
    return Promise.resolve({ kind: "blob", blob });
  }

  abort(): Promise<void> {
    this.parts = [];
    return Promise.resolve();
  }
}

/**
 * Writes blocks straight into a file the recipient chose (File System Access API).
 * Chrome writes to a temporary file and only puts it in place on close(), so an
 * aborted transfer leaves nothing behind.
 */
export class DiskSink implements Sink {
  private readonly writable: FileSystemWritableFileStream;
  private readonly name: string;

  constructor(writable: FileSystemWritableFileStream, name: string) {
    this.writable = writable;
    this.name = name;
  }

  write(block: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.writable.write(block);
  }

  async close(): Promise<SinkResult> {
    await this.writable.close();
    return { kind: "file", name: this.name };
  }

  async abort(): Promise<void> {
    try {
      await this.writable.abort();
    } catch {
      // already closed or aborted
    }
  }
}

type SaveFilePicker = (options: { suggestedName?: string }) => Promise<FileSystemFileHandle>;

/** The save dialog, where the browser has one (Chrome and Edge on desktop). */
function saveFilePicker(): SaveFilePicker | null {
  const picker = (window as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === "function" ? picker.bind(window) : null;
}

export function canSaveToDisk(): boolean {
  return saveFilePicker() !== null;
}

/**
 * Asks where to save the file and opens it for writing. Call it straight from the
 * click that asked to receive: the browser only opens the dialog in response to one.
 * Resolves with null if the recipient closed the dialog without choosing.
 */
export async function chooseDiskSink(suggestedName: string): Promise<Sink | null> {
  const picker = saveFilePicker();
  if (picker === null) throw new Error("this browser cannot save to disk directly");
  let handle: FileSystemFileHandle;
  try {
    handle = await picker({ suggestedName });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
  return new DiskSink(await handle.createWritable(), handle.name);
}
