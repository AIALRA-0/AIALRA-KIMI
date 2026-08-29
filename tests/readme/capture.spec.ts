import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const readmeAssets = resolve("docs/assets/readme");
const uiAssets = resolve(readmeAssets, "ui");

test.beforeAll(async () => {
  await mkdir(uiAssets, { recursive: true });
});

async function openSyntheticDemo(
  page: import("@playwright/test").Page,
  colorScheme: "light" | "dark",
) {
  await page.emulateMedia({ colorScheme });
  await page.goto("/?demo=1");
  await expect(page.getByText("准备发布候选版本").first()).toBeVisible();
}

test("captures the synthetic desktop light theme", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "light",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await openSyntheticDemo(page, "light");
  await page.screenshot({ path: resolve(readmeAssets, "hero-light.png") });
  await context.close();
});

test("captures the synthetic desktop dark theme", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await openSyntheticDemo(page, "dark");
  await page.screenshot({ path: resolve(readmeAssets, "hero-dark.png") });
  await context.close();
});

test("captures the synthetic mobile navigation", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "light",
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await openSyntheticDemo(page, "light");
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "用量" }).click();
  await expect(page.getByText("owner@example.invalid")).toBeVisible();
  await page.screenshot({ path: resolve(uiAssets, "mobile-light.png") });
  await context.close();
});

test("captures outbound-only host pairing", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await openSyntheticDemo(page, "dark");
  await page.getByRole("button", { name: "配对执行主机" }).click();
  await expect(page.getByRole("heading", { name: "命名新主机" })).toBeVisible();
  await page.screenshot({ path: resolve(uiAssets, "pairing-dark.png") });
  await context.close();
});
