import { expect, type Browser, type Page } from "@playwright/test";

export type FileInput = string | { name: string; mimeType: string; buffer: Buffer };

/** Opens the send page in a fresh browser context, chooses a file and returns the share link. */
export async function startSending(browser: Browser, file: FileInput): Promise<{ sender: Page; link: string }> {
  const context = await browser.newContext();
  const sender = await context.newPage();
  await sender.goto("/");
  await sender.locator('input[type="file"]').setInputFiles(file);
  const linkBox = sender.getByLabel("Share link");
  await expect(linkBox).toHaveValue(/\/r#[A-Za-z0-9_-]{22}$/);
  return { sender, link: await linkBox.inputValue() };
}

/** Opens a link in a fresh browser context, as a different person would. */
export async function openAsRecipient(browser: Browser, link: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  return page;
}

export function phase(page: Page) {
  return page.locator("main");
}

export const smallFile = { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from didi\n") };
