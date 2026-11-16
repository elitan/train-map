// Browser smoke tests: the app loads from the binary without errors, and unknown URLs 404.
// (The map itself needs OpenStreetMap and tile servers, so it isn't loaded here.)
import { expect, test } from "@playwright/test";

test("app loads without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/this/does/not/exist");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Lund" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("api health", async ({ request }) => {
  expect((await request.get("/readyz")).ok()).toBe(true);
});
