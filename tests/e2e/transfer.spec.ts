import { expect, test, type Browser } from "@playwright/test";
import { stat } from "node:fs/promises";
import { openAsRecipient, phase, randomFile, sha256OfFile, signallingCounter, startSending } from "./helpers.ts";

const MB = 1024 * 1024;

async function sendAndSave(browser: Browser, path: string, name: string, timeout: number) {
  const signalling = signallingCounter();
  const { sender, link } = await startSending(browser, path, signalling.attach);
  const recipient = await openAsRecipient(browser, link, signalling.attach);

  // The recipient sees the file before anything is transferred, and chooses to receive it.
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");
  await expect(recipient.locator(".file-name")).toHaveText(name);
  await expect(recipient.locator(".route")).toHaveAttribute("data-route", "direct");
  const started = Date.now();
  await recipient.getByRole("button", { name: "Receive file" }).click();

  await expect(phase(recipient)).toHaveAttribute("data-phase", "complete", { timeout });
  await expect(phase(sender)).toHaveAttribute("data-phase", "delivered");
  const seconds = (Date.now() - started) / 1000;

  const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: "Save file" }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  return { saved: await download.path(), seconds, signallingBytes: signalling.bytes(), sender, recipient, link };
}

test("a 1 MB file arrives intact", async ({ browser }, testInfo) => {
  const path = testInfo.outputPath("photo.jpg");
  const hash = await randomFile(path, MB);
  const { saved } = await sendAndSave(browser, path, "photo.jpg", 30_000);
  expect((await stat(saved)).size).toBe(MB);
  expect(await sha256OfFile(saved)).toBe(hash);
});

test("a 100 MB file arrives intact, and its bytes never touch the server", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const size = 100 * MB + 12_345; // not a whole number of blocks
  const path = testInfo.outputPath("footage.mov");
  const hash = await randomFile(path, size);
  const { saved, seconds, signallingBytes } = await sendAndSave(browser, path, "footage.mov", 90_000);
  expect((await stat(saved)).size).toBe(size);
  expect(await sha256OfFile(saved)).toBe(hash);

  // Signalling carried only negotiation: a few kilobytes against 100 MB of file.
  expect(signallingBytes).toBeLessThan(32 * 1024);
  testInfo.annotations.push({ type: "throughput", description: `${(size / MB / seconds).toFixed(1)} MB/s, signalling ${signallingBytes} bytes` });
  console.log(`100 MB: ${(size / MB / seconds).toFixed(1)} MB/s over loopback; signalling carried ${signallingBytes} bytes`);
});

test("an empty file is delivered too", async ({ browser }, testInfo) => {
  const path = testInfo.outputPath("empty.txt");
  const hash = await randomFile(path, 0);
  const { saved } = await sendAndSave(browser, path, "empty.txt", 30_000);
  expect(await sha256OfFile(saved)).toBe(hash);
});

test("after delivery the link stops working", async ({ browser }, testInfo) => {
  const path = testInfo.outputPath("notes.txt");
  await randomFile(path, 1000);
  const { link } = await sendAndSave(browser, path, "notes.txt", 30_000);
  const late = await openAsRecipient(browser, link);
  await expect(late.getByRole("alert")).toContainText("This link isn’t active");
});

test("the recipient stopping mid-transfer tells the sender, and can try again", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  const hash = await randomFile(path, 400 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link);
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await recipient.getByRole("button", { name: "Stop receiving" }).click();

  await expect(recipient.getByRole("alert")).toHaveText("You stopped receiving. The partial file was discarded.");
  await expect(phase(sender)).toHaveAttribute("data-phase", "waiting");
  await expect(sender.locator(".notice")).toHaveText("The recipient stopped the transfer.");

  // The link still works; a second attempt starts from the beginning.
  await recipient.getByRole("button", { name: "Try again" }).click();
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(recipient)).toHaveAttribute("data-phase", "complete", { timeout: 90_000 });
  const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: "Save file" }).click()]);
  expect(await sha256OfFile(await download.path())).toBe(hash);
});

test("the sender stopping mid-transfer tells the recipient", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  await randomFile(path, 400 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link);
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(sender)).toHaveAttribute("data-phase", "sending");
  await sender.getByRole("button", { name: "Stop sharing" }).click();

  await expect(recipient.getByRole("alert")).toHaveText("The sender stopped sharing this file.");
  await expect(phase(sender)).toHaveAttribute("data-phase", "idle");
});

test("the sender closing the page mid-transfer is reported to the recipient", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  await randomFile(path, 400 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link);
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(sender)).toHaveAttribute("data-phase", "sending");
  await sender.close({ runBeforeUnload: false });

  // Mid-transfer, the closing page's goodbye doesn't reliably get out, so this is
  // the crash path: signalling reports the page gone and ICE loses contact (~5 s).
  await expect(recipient.getByRole("alert")).toHaveText("The connection to the sender dropped.", { timeout: 10_000 });
});
