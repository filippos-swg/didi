import { chromium, expect, test, webkit, type Browser, type BrowserContext } from "@playwright/test";
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phase, prepareRecipient, sha256OfFile, startSending } from "../e2e/helpers.ts";
import { bigFile, savedBlocks, watchMemory, type BigFile } from "./support.ts";

const BASE = "http://localhost:8092";
const MB = 1024 * 1024;
const LIMIT = 2 * 1024 ** 3; // exactly the v0.1 maximum

const CHROMIUM_ARGS = ["--disable-features=WebRtcHideLocalIpsWithMdns"];

// The recipient gets an ordinary on-disk profile. Playwright's usual contexts are
// private windows, where both engines keep page storage and large Blobs in memory
// with a small quota: fine for normal tests, but it would measure the wrong thing here.
const engines = {
  chromium: {
    launch: () => chromium.launch({ args: CHROMIUM_ARGS }),
    persistent: (profile: string) => chromium.launchPersistentContext(profile, { args: CHROMIUM_ARGS, acceptDownloads: true }),
    processes: /ms-playwright\/chromium/,
  },
  webkit: {
    launch: () => webkit.launch(),
    persistent: (profile: string) => webkit.launchPersistentContext(profile, { acceptDownloads: true }),
    processes: /ms-playwright\/webkit/,
  },
} as const;
type Engine = keyof typeof engines;

interface Run {
  from: Engine;
  to: Engine;
  save: "disk" | "memory";
  file: () => Promise<BigFile>;
}

async function measure({ from, to, save, file: make }: Run, record: (line: string) => void) {
  const file = await make();
  const name = file.path.split("/").at(-1) ?? "file";
  const profile = await mkdtemp(join(tmpdir(), "didi-scale-profile-"));
  let senderBrowser: Browser | null = null;
  let recipientContext: BrowserContext | null = null;
  try {
    senderBrowser = await engines[from].launch();
    recipientContext = await engines[to].persistent(profile);
    const memory = from === to ? [watchMemory(engines[from].processes)] : [watchMemory(engines[from].processes), watchMemory(engines[to].processes)];

    const { sender, link } = await startSending(senderBrowser, file.path, undefined, BASE);
    const recipient = recipientContext.pages()[0] ?? (await recipientContext.newPage());
    await prepareRecipient(recipient, save);
    await recipient.goto(link);
    await expect(phase(recipient)).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    const before = await Promise.all(memory.map((watch) => watch.now()));

    const started = Date.now();
    await recipient.getByRole("button", { name: "Receive file" }).click();
    // Fail fast with the page's own explanation rather than waiting out the timeout.
    await expect(phase(recipient)).toHaveAttribute("data-phase", /^(complete|failed)$/, { timeout: 18 * 60_000 });
    if ((await phase(recipient).getAttribute("data-phase")) === "failed") {
      throw new Error(`the recipient failed: ${await recipient.getByRole("alert").textContent()}`);
    }
    const seconds = (Date.now() - started) / 1000;
    await expect(phase(sender)).toHaveAttribute("data-phase", "delivered");
    const peaks = await Promise.all(memory.map((watch) => watch.stop()));

    // Check the saved copy against the source, independently of didi's own checks.
    if (save === "disk") {
      expect(await savedBlocks(recipient, name)).toEqual(file.blocks);
    } else {
      const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: "Save file" }).click()]);
      const saved = await download.path();
      expect((await stat(saved)).size).toBe(file.size);
      expect(await sha256OfFile(saved)).toBe(file.sha256);
    }

    const size = `${(file.size / MB).toFixed(0)} MB`;
    const memoryText =
      from === to
        ? `${from} processes: ${before[0]} MB before, peak ${peaks[0]?.peakMB} MB`
        : `${from}: ${before[0]} → peak ${peaks[0]?.peakMB} MB; ${to}: ${before[1]} → peak ${peaks[1]?.peakMB} MB`;
    record(`${from} → ${to}, ${save}, ${size}: ${seconds.toFixed(0)} s, ${(file.size / MB / seconds).toFixed(1)} MB/s; ${memoryText}; intact`);
  } finally {
    await recipientContext?.close();
    await senderBrowser?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const halfGig = () => bigFile("half-gig.bin", 500 * MB);
const atLimit = () => bigFile("at-limit.bin", LIMIT);

const runs: Run[] = [
  { from: "chromium", to: "chromium", save: "disk", file: halfGig },
  { from: "chromium", to: "chromium", save: "disk", file: atLimit },
  { from: "chromium", to: "chromium", save: "memory", file: atLimit },
  { from: "chromium", to: "webkit", save: "memory", file: halfGig },
  { from: "chromium", to: "webkit", save: "memory", file: atLimit },
  { from: "webkit", to: "chromium", save: "disk", file: atLimit },
];

for (const run of runs) {
  const label = `${run.from} → ${run.to}, ${run.save}, ${run.file === atLimit ? "2 GiB (the limit)" : "500 MB"}`;
  test(label, async ({}, testInfo) => {
    await measure(run, (line) => {
      console.log(line);
      testInfo.annotations.push({ type: "result", description: line });
      void appendFile(join(testInfo.project.outputDir, "scale-results.txt"), `${new Date().toISOString()} ${line}\n`);
    });
  });
}
