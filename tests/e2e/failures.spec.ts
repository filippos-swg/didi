import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { utimes } from "node:fs/promises";
import { openAsRecipient, phase, randomFile, sha256OfFile, smallFile, startSending } from "./helpers.ts";

const MB = 1024 * 1024;

/**
 * Sits between a page and didi's signalling server, so a test can cut the
 * connection, refuse reconnects for a while, and then let them through.
 */
function signallingSwitch() {
  let refusing = false;
  let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null;
  return {
    async attach(page: Page) {
      await page.routeWebSocket(/\/signal$/, (route) => {
        if (refusing) {
          void route.close({ code: 4000 });
          return;
        }
        current = { page: route, server: route.connectToServer() }; // forwards both ways
      });
    },
    async cut() {
      refusing = true;
      const connection = current;
      if (connection === null) throw new Error("no signalling connection to cut: was attach() awaited before the page connected?");
      current = null;
      // A code other than 1000/1001 reads to the server as a dropped network, not a closed page.
      await connection.server.close({ code: 4000 });
      await connection.page.close({ code: 4000 });
    },
    restore() {
      refusing = false;
    },
    refuse() {
      refusing = true;
    },
  };
}

async function crash(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  void cdp.send("Page.crash").catch(() => {});
}

test("a file changed on disk after it was chosen stops the transfer clearly on both sides", async ({ browser }, testInfo) => {
  const path = testInfo.outputPath("draft.txt");
  await randomFile(path, 3 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link);
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");

  const later = new Date(Date.now() + 60_000);
  await utimes(path, later, later); // the file is edited after being chosen
  await recipient.getByRole("button", { name: "Receive file" }).click();

  await expect(sender.getByRole("alert")).toHaveText(
    "The file couldn’t be read. It may have been moved or changed after you chose it. Choose it again to send it.",
  );
  await expect(recipient.getByRole("alert")).toHaveText("The sender’s copy of the file couldn’t be read, so the transfer stopped.");
});

test("the recipient's browser crashing mid-transfer is reported to the sender, and the link still works", async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "Page.crash is a Chrome DevTools command");
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  const hash = await randomFile(path, 200 * MB);
  const { sender, link } = await startSending(browser, path);
  const first = await openAsRecipient(browser, link);
  await first.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(sender)).toHaveAttribute("data-phase", "sending");

  await crash(first);
  await expect(sender.locator(".notice")).toHaveText("The connection to the recipient dropped.", { timeout: 10_000 });
  await expect(phase(sender)).toHaveAttribute("data-phase", "waiting");

  const second = await openAsRecipient(browser, link);
  await second.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(second)).toHaveAttribute("data-phase", "complete", { timeout: 90_000 });
  const [download] = await Promise.all([second.waitForEvent("download"), second.getByRole("link", { name: "Save file" }).click()]);
  expect(await sha256OfFile(await download.path())).toBe(hash);
});

test("a transfer that stops moving says so on both sides, and carries on when it can", async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "pausing a page uses the Chrome DevTools debugger");
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  await randomFile(path, 300 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link);
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(recipient.locator(".progress-text")).toContainText("/s");

  // Freeze the recipient's page: nothing is acknowledged, so the sender runs out of window.
  const recipientDebugger = await recipient.context().newCDPSession(recipient);
  await recipientDebugger.send("Debugger.enable");
  await recipientDebugger.send("Debugger.pause");
  await expect(sender.locator(".stalled")).toHaveText(/^Nothing delivered for \d+ s\. Waiting for the connection to recover…$/, { timeout: 20_000 });
  await recipientDebugger.send("Debugger.resume");
  await expect(sender.locator(".stalled")).toHaveCount(0, { timeout: 10_000 });

  // Freeze the sender's page: nothing more arrives at the recipient.
  const senderDebugger = await sender.context().newCDPSession(sender);
  await senderDebugger.send("Debugger.enable");
  await senderDebugger.send("Debugger.pause");
  await expect(recipient.locator(".stalled")).toHaveText(/^Nothing received for \d+ s\. Waiting for the connection to recover…$/, { timeout: 20_000 });
  await senderDebugger.send("Debugger.resume");
  await expect(recipient.locator(".stalled")).toHaveCount(0, { timeout: 10_000 });

  await expect(phase(recipient)).toHaveAttribute("data-phase", "complete", { timeout: 90_000 });
});

test("while didi's server can't be reached, the sender is told the link is being retried", async ({ browser }) => {
  const signalling = signallingSwitch();
  signalling.refuse();
  const context = await browser.newContext();
  const sender = await context.newPage();
  await signalling.attach(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').setInputFiles(smallFile);
  await expect(sender.locator(".notice")).toHaveText("Can’t reach the didi server. Retrying…");

  signalling.restore();
  await expect(sender.getByLabel("Share link")).toHaveValue(/\/r#[A-Za-z0-9_-]{22}$/, { timeout: 15_000 });
  await expect(sender.locator(".notice")).toHaveCount(0);
});

test("a sender that loses the server is shown as offline, and the same link works once it reconnects", async ({ browser }) => {
  test.setTimeout(60_000);
  const signalling = signallingSwitch();
  const { sender, link } = await startSending(browser, smallFile, signalling.attach);

  await signalling.cut();
  await expect(sender.locator(".notice")).toContainText("Lost contact with the didi server. Reconnecting…");

  const recipient = await openAsRecipient(browser, link);
  await expect(recipient.getByRole("alert")).toHaveText("The sender’s page isn’t connected right now. It may be reconnecting.");

  signalling.restore();
  await expect(sender.locator(".notice")).toHaveCount(0, { timeout: 15_000 });
  await expect(sender.getByLabel("Share link")).toHaveValue(link); // same session, same link
  await recipient.getByRole("button", { name: "Try again" }).click();
  await expect(phase(recipient)).toHaveAttribute("data-phase", "ready");
});

test("a transfer carries on when the sender loses the server mid-transfer", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  const hash = await randomFile(path, 150 * MB);
  const signalling = signallingSwitch();
  const { sender, link } = await startSending(browser, path, signalling.attach);
  const recipient = await openAsRecipient(browser, link);
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(sender)).toHaveAttribute("data-phase", "sending");

  await signalling.cut(); // and stays cut: the file doesn't need the server
  await expect(phase(recipient)).toHaveAttribute("data-phase", "complete", { timeout: 90_000 });
  await expect(phase(sender)).toHaveAttribute("data-phase", "delivered");
  const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: "Save file" }).click()]);
  expect(await sha256OfFile(await download.path())).toBe(hash);
});

test("a recipient who can't reach didi's server is told so", async ({ browser }) => {
  const { link } = await startSending(browser, smallFile);
  const signalling = signallingSwitch();
  signalling.refuse();
  const recipient = await openAsRecipient(browser, link, { onPage: signalling.attach });
  await expect(recipient.getByRole("alert")).toHaveText(/^(Couldn’t reach the didi server\. Check your connection\.|Lost contact with the didi server before the connection to the sender was made\.)$/);
  await expect(recipient.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("leaving mid-transfer asks first, on both sides", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const path = testInfo.outputPath("big.bin");
  await randomFile(path, 300 * MB);
  const { sender, link } = await startSending(browser, path);
  const recipient = await openAsRecipient(browser, link);
  await recipient.getByRole("button", { name: "Receive file" }).click();
  await expect(phase(recipient)).toHaveAttribute("data-phase", "receiving");
  await sender.locator("h1").click(); // browsers only ask pages the person has interacted with

  for (const page of [recipient, sender]) {
    const asked = page.waitForEvent("dialog");
    await page.close({ runBeforeUnload: true });
    const dialog = await asked;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss(); // stay on the page
  }
  await expect(phase(recipient)).toHaveAttribute("data-phase", /receiving|complete/);
});
