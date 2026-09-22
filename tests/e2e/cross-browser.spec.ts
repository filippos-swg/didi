import { chromium, expect, test, webkit } from "@playwright/test";
import { openAsRecipient, phase, randomFile, savedFile, sha256OfFile, startSending } from "./helpers.ts";

// Each test launches one engine to send and another to receive.
const engines = {
  chromium: () => chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] }),
  webkit: () => webkit.launch(),
};

const MB = 1024 * 1024;

for (const [from, to] of [
  ["chromium", "webkit"],
  ["webkit", "chromium"],
] as const) {
  test(`${from} sends a file to ${to}`, async ({ baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const size = 50 * MB + 3;
    const path = testInfo.outputPath("clip.mov");
    const hash = await randomFile(path, size);
    const senderBrowser = await engines[from]();
    const recipientBrowser = await engines[to]();
    try {
      const { sender, link } = await startSending(senderBrowser, path, undefined, baseURL);
      // Chrome saves to disk; WebKit, like Safari, cannot, and receives into memory.
      const save = to === "chromium" ? "disk" : "memory";
      const recipient = await openAsRecipient(recipientBrowser, link, { save });
      await expect(recipient.locator(".route")).toHaveAttribute("data-route", "direct", { timeout: 30_000 });
      await recipient.getByRole("button", { name: "Receive file" }).click();
      await expect(phase(recipient)).toHaveAttribute("data-phase", "complete", { timeout: 90_000 });
      await expect(phase(sender)).toHaveAttribute("data-phase", "delivered");

      if (save === "disk") {
        expect(await savedFile(recipient, "clip.mov")).toEqual({ size, sha256: hash });
      } else {
        const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: "Save file" }).click()]);
        expect(await sha256OfFile(await download.path())).toBe(hash);
      }
    } finally {
      await senderBrowser.close();
      await recipientBrowser.close();
    }
  });
}
