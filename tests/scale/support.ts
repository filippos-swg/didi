import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const BLOCK = 1024 * 1024;
export const SCALE_DIR = join(tmpdir(), "didi-scale");

export interface BigFile {
  path: string;
  size: number;
  sha256: string;
  /** SHA-256 of each 1 MiB block, computed from the source, to check a saved copy against. */
  blocks: string[];
}

/** A file of random bytes. Kept in the temp folder between runs, because it is slow to make. */
export async function bigFile(name: string, size: number): Promise<BigFile> {
  await mkdir(SCALE_DIR, { recursive: true });
  const path = join(SCALE_DIR, name);
  try {
    const known = JSON.parse(await readFile(`${path}.json`, "utf8")) as BigFile;
    if (known.size === size && (await stat(path)).size === size) return known;
  } catch {
    // not made yet
  }
  const whole = createHash("sha256");
  const blocks: string[] = [];
  const handle = await open(path, "w");
  try {
    for (let written = 0; written < size; ) {
      const chunk = randomBytes(Math.min(BLOCK, size - written));
      whole.update(chunk);
      blocks.push(createHash("sha256").update(chunk).digest("hex"));
      await handle.write(chunk);
      written += chunk.length;
    }
  } finally {
    await handle.close();
  }
  const file: BigFile = { path, size, sha256: whole.digest("hex"), blocks };
  await writeFile(`${path}.json`, JSON.stringify(file));
  return file;
}

/** Per-block SHA-256 of a file the "disk" stand-in saved into the page's private storage. */
export function savedBlocks(page: Page, name: string): Promise<string[]> {
  return page.evaluate(
    async ({ fileName, block }) => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle(fileName)).getFile();
      const hashes: string[] = [];
      for (let offset = 0; offset < file.size; offset += block) {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.slice(offset, offset + block).arrayBuffer()));
        hashes.push([...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
      }
      return hashes;
    },
    { fileName: name, block: BLOCK },
  );
}

const run = promisify(execFile);

/** Resident memory of every process whose command line matches, sampled twice a second. */
export function watchMemory(pattern: RegExp): { now(): Promise<number>; stop(): Promise<{ peakMB: number }> } {
  let peak = 0;
  let stopped = false;
  const sample = async (): Promise<number> => {
    const { stdout } = await run("ps", ["-Ao", "rss=,command="], { maxBuffer: 32 * 1024 * 1024 });
    let kilobytes = 0;
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined && pattern.test(match[2])) kilobytes += Number(match[1]);
    }
    return kilobytes;
  };
  const loop = (async () => {
    while (!stopped) {
      try {
        peak = Math.max(peak, await sample());
      } catch {
        // ps can fail transiently; the next sample will do
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  return {
    now: async () => Math.round((await sample()) / 1024),
    async stop() {
      stopped = true;
      await loop;
      return { peakMB: Math.round(peak / 1024) };
    },
  };
}
