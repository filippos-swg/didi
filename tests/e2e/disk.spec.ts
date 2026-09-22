import { expect, test } from "@playwright/test";
import { openAsRecipient, phase, randomFile, savedFile, smallFile, startSending } from "./helpers.ts";

const MB = 1024 * 1024;

test("Chrome saves straight to disk, and the file on disk matches the original", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const size = 100 * MB + 777;
  const path = testInfo.outputPath("footage.mov");
  const hash = await randomFile(path, size);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link, { save: "disk" });

  await expect(recipient.locator(".hint")).toContainText("You’ll choose where to save it.");
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(recipient)).toHaveAttribute("data-phase", "complete", { timeout: 90_000 });
  await expect(recipient.locator(".saved")).toHaveText("Saved as footage.mov.");
  await expect(recipient.getByRole("link", { name: "Save file" })).toHaveCount(0);
  await expect(phase(sender)).toHaveAttribute("data-phase", "delivered");

  expect(await savedFile(recipient, "footage.mov")).toEqual({ size, sha256: hash });
});

test("closing the save dialog without choosing changes nothing", async ({ browser }) => {
  const { sender, link } = await startSending(browser, smallFile);
  const recipient = await openAsRecipient(browser, link, { save: "disk" });
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");

  // The first time the dialog opens, the recipient closes it.
  await recipient.evaluate(() => {
    const choose = (window as unknown as { showSaveFilePicker: (options: unknown) => Promise<unknown> }).showSaveFilePicker;
    let first = true;
    Object.defineProperty(window, "showSaveFilePicker", {
      value: (options: unknown) => {
        if (!first) return choose(options);
        first = false;
        return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
      },
    });
  });
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");
  await expect(phase(sender)).toHaveAttribute("data-phase", "connected");

  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(recipient)).toHaveAttribute("data-phase", "complete");
  expect((await savedFile(recipient, "hello.txt")).size).toBe(smallFile.buffer.byteLength);
});

test("a disk that fails mid-transfer is reported on both sides", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const path = testInfo.outputPath("big.bin");
  await randomFile(path, 20 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link, { save: "disk" });
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");

  // A disk that fills up after three blocks.
  await recipient.evaluate(() => {
    let writes = 0;
    Object.defineProperty(window, "showSaveFilePicker", {
      value: () =>
        Promise.resolve({
          name: "big.bin",
          createWritable: () =>
            Promise.resolve({
              write: () => (++writes > 3 ? Promise.reject(new DOMException("disk full", "QuotaExceededError")) : Promise.resolve()),
              close: () => Promise.resolve(),
              abort: () => Promise.resolve(),
            }),
        }),
    });
  });
  await recipient.getByRole("button", { name: "Receive file" }).click();

  await expect(recipient.getByRole("alert")).toHaveText("Your browser couldn’t save the file. Your disk may be full.");
  await expect(phase(sender)).toHaveAttribute("data-phase", "waiting");
  await expect(sender.locator(".notice")).toHaveText("The recipient’s browser couldn’t save the file. Their disk may be full.");
});

test("the sender stopping before the recipient accepts is reported as stopping", async ({ browser }) => {
  const { sender, link } = await startSending(browser, smallFile);
  const recipient = await openAsRecipient(browser, link);
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");
  await sender.getByRole("button", { name: "Stop sharing" }).click();
  await expect(recipient.getByRole("alert")).toHaveText("The sender stopped sharing this file.");
});
