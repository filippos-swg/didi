import { expect, test } from "@playwright/test";
import { openAsRecipient, phase, smallFile, startSending } from "./helpers.ts";

test("a recipient connects directly to the sender", async ({ browser, browserName }) => {
  const { sender, link } = await startSending(browser, smallFile);
  await expect(phase(sender)).toHaveAttribute("data-phase", "waiting");

  const recipient = await openAsRecipient(browser, link);
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");
  await expect(phase(sender)).toHaveAttribute("data-phase", "connected");

  await expect(recipient.locator(".route")).toHaveAttribute("data-route", "direct");
  await expect(sender.locator(".route")).toHaveAttribute("data-route", "direct");
  if (browserName === "chromium") {
    // Two Chrome contexts on one machine connect over their local addresses.
    await expect(recipient.locator(".route")).toHaveText("Direct connection, same network");
    await expect(sender.locator(".route")).toHaveText("Direct connection, same network");
  }
});

test("an unknown link is reported as not active", async ({ page }) => {
  await page.goto("/r#AAAAAAAAAAAAAAAAAAAAAA");
  await expect(phase(page)).toHaveAttribute("data-phase", "unavailable");
  await expect(page.getByRole("alert")).toContainText("This link isn’t active");
});

test("an incomplete link is reported without contacting the server", async ({ page }) => {
  await page.goto("/r#tooShort");
  await expect(page.getByRole("alert")).toContainText("This link is incomplete");
});

test("a second recipient is told someone else is receiving", async ({ browser }) => {
  const { link } = await startSending(browser, smallFile);
  const first = await openAsRecipient(browser, link);
  await expect(phase(first)).toHaveAttribute("data-phase", "ready");

  const second = await openAsRecipient(browser, link);
  await expect(phase(second)).toHaveAttribute("data-phase", "unavailable");
  await expect(second.getByRole("alert")).toContainText("Someone else is receiving this file");
});

test("when the recipient leaves, the sender waits for another attempt", async ({ browser }) => {
  const { sender, link } = await startSending(browser, smallFile);
  const recipient = await openAsRecipient(browser, link);
  await expect(phase(sender)).toHaveAttribute("data-phase", "connected");

  await recipient.close();
  await expect(phase(sender)).toHaveAttribute("data-phase", "waiting");
  await expect(sender.locator(".notice")).toHaveText("The connection to the recipient dropped.");

  const again = await openAsRecipient(browser, link);
  await expect(phase(again)).toHaveAttribute("data-phase", "ready");
});

test("when the sender closes the page, the recipient is told the connection dropped", async ({ browser }) => {
  const { sender, link } = await startSending(browser, smallFile);
  const recipient = await openAsRecipient(browser, link);
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");

  await sender.close({ runBeforeUnload: false });
  await expect(phase(recipient)).toHaveAttribute("data-phase", "failed");
  await expect(recipient.getByRole("alert")).toHaveText("The connection to the sender dropped.");
});

test("after the sender stops sharing, the link is not active", async ({ browser }) => {
  const { sender, link } = await startSending(browser, smallFile);
  await sender.getByRole("button", { name: "Stop sharing" }).click();
  await expect(phase(sender)).toHaveAttribute("data-phase", "idle");

  const recipient = await openAsRecipient(browser, link);
  await expect(recipient.getByRole("alert")).toContainText("This link isn’t active");
});

test("a file over 2 GB is refused before anything is shared", async ({ page }) => {
  await page.goto("/");
  // Report a size over the limit without creating a 2 GB file.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    const file = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(file, "size", { value: 2 * 1024 ** 3 + 1 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("alert")).toHaveText("huge.mov is 2.00 GB. didi sends files up to 2 GB.");
  await expect(phase(page)).toHaveAttribute("data-phase", "idle");
});

test("when the sender page crashes, the recipient notices within seconds", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Page.crash is a Chrome DevTools command");
  const { sender, link } = await startSending(browser, smallFile);
  const recipient = await openAsRecipient(browser, link);
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");

  // A crash sends nothing to the other side. ICE reports "disconnected" after
  // about 5 s; with signalling confirming the page is gone, that is enough.
  const cdp = await sender.context().newCDPSession(sender);
  void cdp.send("Page.crash").catch(() => {});
  await expect(phase(recipient)).toHaveAttribute("data-phase", "failed", { timeout: 10_000 });
});

test("a connection that can't be made explains itself on both sides", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "the expected explanation assumes no STUN, which only the Chromium tests run without");
  test.setTimeout(60_000);
  // Throw away every address the other browser sends, so no path can ever be found.
  const blockAddresses = (page: import("@playwright/test").Page) =>
    void page.addInitScript(() => {
      RTCPeerConnection.prototype.addIceCandidate = () => Promise.resolve();
    });
  const { sender, link } = await startSending(browser, smallFile, blockAddresses);
  const recipient = await openAsRecipient(browser, link, { onPage: blockAddresses });

  await expect(recipient.getByRole("alert")).toHaveText("Couldn’t connect directly to the sender.", { timeout: 30_000 });
  // No STUN in tests, so neither browser has a public address; the explanation says so.
  await expect(recipient.locator(".connection-details")).toContainText("Your browser couldn’t find its public internet address");
  await recipient.getByText("Connection details").click();
  await expect(recipient.locator(".connection-details dl")).toContainText("no connection after 20 s");

  await expect(phase(sender)).toHaveAttribute("data-phase", "waiting");
  await expect(sender.locator(".notice")).toHaveText("Couldn’t connect directly to the recipient. They can open the link again to retry.");
  await expect(sender.locator(".connection-details")).toBeVisible();
});
