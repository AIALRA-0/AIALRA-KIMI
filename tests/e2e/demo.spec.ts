import { expect, test } from "@playwright/test";

async function openMobileNavigation(
  page: import("@playwright/test").Page,
  projectName: string,
) {
  if (projectName.startsWith("mobile")) {
    await page.getByRole("button", { name: "打开导航" }).click();
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?demo=1");
});

test("keeps session mode and new-session default separate", async ({
  page,
}, testInfo) => {
  const yolo = page.getByRole("button", { name: "YOLO" });
  await yolo.click();
  await expect(yolo).toHaveAttribute("aria-pressed", "true");

  await openMobileNavigation(page, testInfo.project.name);
  await page.getByRole("button", { name: "设置" }).click();
  await page
    .getByRole("combobox", { name: "新会话默认权限" })
    .selectOption("auto");
  await openMobileNavigation(page, testInfo.project.name);
  await page.getByRole("button", { name: "新建会话" }).click();
  await expect(
    page.getByRole("combobox", { name: "默认权限模式" }),
  ).toHaveValue("auto");
});

test("loads the terminal on demand and accepts input", async ({
  page,
}, testInfo) => {
  await openMobileNavigation(page, testInfo.project.name);
  await page.getByRole("button", { name: "终端" }).click();
  const input = page.getByRole("textbox", { name: "终端输入" });
  await input.click();
  await page.keyboard.type("echo AIALRA-DEMO-OK");
  await page.keyboard.press("Enter");
  await expect(page.getByText("echo AIALRA-DEMO-OK")).toBeVisible();
});

test("supports the mobile navigation without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("button", { name: "用量" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "关闭导航", exact: true }).click();
  const heading = page.getByRole("heading", {
    name: "准备发布候选版本",
  });
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
});

test("offers outbound-only VPS and remote host pairing", async ({
  page,
}, testInfo) => {
  await openMobileNavigation(page, testInfo.project.name);
  await page.getByRole("button", { name: "配对执行主机" }).click();
  await expect(page.getByRole("heading", { name: "命名新主机" })).toBeVisible();
  const mode = page.getByRole("combobox", { name: "执行模式" });
  await expect(mode).toHaveValue("remote");
  await mode.selectOption("vps");
  await expect(mode).toHaveValue("vps");
  await expect(
    page.getByText("主机只主动向外连接，不开放公网端口"),
  ).toBeVisible();
});

test("shows usage percentages and styled selects", async ({
  page,
}, testInfo) => {
  await openMobileNavigation(page, testInfo.project.name);
  await page.getByRole("button", { name: "用量" }).click();
  await expect(page.getByText("63% 已用")).toBeVisible();
  await expect(page.getByText("18% 已用")).toBeVisible();

  await openMobileNavigation(page, testInfo.project.name);
  await page.getByRole("button", { name: "设置" }).click();
  const select = page.getByRole("combobox", { name: "新会话默认权限" });
  await expect(select).toHaveCSS("appearance", "none");
  await expect(select).not.toHaveCSS("background-image", "none");
});

test("renders Markdown and collapses completed tool calls", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "发布检查", level: 2 }),
  ).toBeVisible();
  await expect(page.getByRole("listitem").first()).toContainText(
    "控制平面构建",
  );

  const tool = page.locator("details.tool-card").first();
  await expect(tool).not.toHaveAttribute("open", "");
  await expect(tool.getByText("health: ok")).not.toBeVisible();
  await tool.locator("summary").click();
  await expect(tool.getByText("health: ok")).toBeVisible();
  await expect(tool.getByText("<system>")).toHaveCount(0);
});
