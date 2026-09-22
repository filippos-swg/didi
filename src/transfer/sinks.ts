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
