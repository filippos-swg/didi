import { expect, type Browser, type Page } from "@playwright/test";

export type FileInput = string | { name: string; mimeType: string; buffer: Buffer };

/** Opens the send page in a fresh browser context, chooses a file and returns the share link. */
export async function startSending(
  browser: Browser,
  file: FileInput,
  onPage?: (page: Page) => void | Promise<void>,
): Promise<{ sender: Page; link: string }> {
  const context = await browser.newContext();
  const sender = await context.newPage();
  await onPage?.(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').setInputFiles(file);
  const linkBox = sender.getByLabel("Share link");
  await expect(linkBox).toHaveValue(/\/r#[A-Za-z0-9_-]{22}$/);
  return { sender, link: await linkBox.inputValue() };
}

export interface RecipientOptions {
  onPage?: (page: Page) => void | Promise<void>;
  /**
   * "memory": behave like Firefox and Safari, which cannot save to disk directly.
   * "disk": save to disk, with a stand-in for Chrome's native save dialog (which
   * tests cannot click) that writes into the page's private storage (OPFS).
   */
  save?: "memory" | "disk";
}

/** Opens a link in a fresh browser context, as a different person would. */
export async function openAsRecipient(browser: Browser, link: string, options: RecipientOptions = {}): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await options.onPage?.(page);
  if ((options.save ?? "memory") === "memory") {
    await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined }));
  } else {
    await page.addInitScript(() =>
      Object.defineProperty(window, "showSaveFilePicker", {
        value: async ({ suggestedName }: { suggestedName: string }) =>
          (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true }),
      }),
    );
  }
  await page.goto(link);
  return page;
}

/** Size and SHA-256 of a file the "disk" stand-in saved. */
export function savedFile(page: Page, name: string): Promise<{ size: number; sha256: string }> {
  return page.evaluate(async (fileName) => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle(fileName)).getFile();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
    return { size: file.size, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  }, name);
}

export function phase(page: Page) {
  return page.locator("main");
}

export const smallFile = { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from didi\n") };

/** Writes a file of random bytes and returns its SHA-256. */
export async function randomFile(path: string, size: number): Promise<string> {
  const { createHash, randomBytes } = await import("node:crypto");
  const { open } = await import("node:fs/promises");
  const hash = createHash("sha256");
  const handle = await open(path, "w");
  try {
    for (let written = 0; written < size; ) {
      const chunk = randomBytes(Math.min(8 * 1024 * 1024, size - written));
      hash.update(chunk);
      await handle.write(chunk);
      written += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function sha256OfFile(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Counts every byte the pages it is attached to exchange with the signalling server. */
export function signallingCounter(): { attach: (page: Page) => void; bytes: () => number } {
  let total = 0;
  return {
    attach(page) {
      page.on("websocket", (socket) => {
        if (!socket.url().endsWith("/signal")) return;
        socket.on("framesent", (frame) => (total += Buffer.byteLength(frame.payload)));
        socket.on("framereceived", (frame) => (total += Buffer.byteLength(frame.payload)));
      });
    },
    bytes: () => total,
  };
}
