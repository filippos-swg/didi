import { expect, test } from "@playwright/test";

test("send and receive pages load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "didi" })).toBeVisible();
  await page.goto("/r#AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { name: "didi" })).toBeVisible();
});
