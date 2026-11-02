import { expect, test } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:4184" });

test("new account imports, corrects and reviews knowledge through the real backend", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("邮箱", { exact: true }).fill("reader@local.test");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-test-password");
  await page.getByLabel("确认密码", { exact: true }).fill("synthetic-test-password");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: /reader/ })).toBeVisible();
  await page.goto("/#/settings");
  const token = await page.evaluate(() => localStorage.getItem("tuantuan-auth-token"));
  await page.getByRole("link", { name: "了解 团团" }).click();
  await expect(page).toHaveURL(/#\/about$/);
  await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
  await page.getByRole("link", { name: "返回应用", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("button", { name: /账号与安全/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("tuantuan-auth-token"))).toBe(token);
  await page.goto("/#/library");
  await page.getByLabel("选择上传文件").setInputFiles([
    { name: "reading.md", mimeType: "text/markdown", buffer: Buffer.from("阅读结论：每周整理问题，联系 reader@example.test。") },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("辅助笔记：按主题整理资料。") }
  ]);
  const list = page.getByRole("table", { name: "文件列表" });
  await expect(list.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "操作 reading" }).click();
  await page.getByRole("button", { name: "快速预览" }).click();
  const preview = page.getByRole("complementary", { name: "文件快速预览" });
  await expect(preview).toContainText("reader@example.test");
  await preview.getByRole("button", { name: "AI 读取内容" }).click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByLabel("编辑资料正文").fill("阅读结论：每周整理一次阅读笔记，联系 reader@example.test。");
  await page.getByRole("button", { name: "保存正文", exact: true }).click();
  await expect(preview).toContainText("正文已校正");
  // 上传默认仅存档；先开启长期使用，后续对话才能检索到正文。
  // 勾选框由接口结果驱动，点击后等待保存完成再断言，而不是要求点击当下立即变化。
  await page.getByRole("checkbox", { name: "长期使用" }).click();
  await expect(page.getByRole("checkbox", { name: "长期使用" })).toBeChecked();
  await page.getByRole("button", { name: "关闭快速预览" }).click();
  await page.getByRole("button", { name: "操作 reading" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("reading.md");
  await page.goto("/#/chat");
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("根据我的知识库回答阅读结论");
  await page.getByRole("button", { name: "发送" }).click();
  const log = page.getByRole("log");
  await expect(log).toContainText("每周整理一次阅读笔记");
  await expect(log).not.toContainText("reader@example.test");
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  await composer.fill("记住每周整理一次阅读笔记");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(log).toContainText("等待你确认");
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  await page.goto("/#/library");
  await page.getByRole("button", { name: "文件库更多选项" }).click();
  await page.getByRole("button", { name: "知识", exact: true }).click();
  await expect(page.getByRole("region", { name: "待确认内容" })).toContainText("每周整理一次阅读笔记");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("region", { name: "待确认内容" })).toContainText("暂无待确认知识");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "操作 reading" }).click();
  await page.getByRole("button", { name: "快速预览" }).click();
  // 勾选框由接口结果驱动，点击后等待保存完成再断言，而不是要求点击当下立即变化。
  await page.getByRole("checkbox", { name: "长期使用" }).click();
  await expect(page.getByRole("checkbox", { name: "长期使用" })).not.toBeChecked();
  await page.getByRole("button", { name: "关闭快速预览" }).click();
  await page.getByRole("button", { name: "操作 notes" }).click();
  await page.getByRole("button", { name: "移入回收站" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "移入回收站" }).click();
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await page.reload();
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(list).toContainText("仅存档");
  await page.getByRole("button", { name: "文件库更多选项" }).click();
  await page.getByRole("button", { name: "搜索与筛选" }).click();
  await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("trash");
  await page.getByRole("button", { name: "恢复 notes" }).click();
  await expect(page.getByText("回收站是空的")).toBeVisible();
  await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("all");
  await expect(list.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "选择 notes", exact: true }).check();
  await page.getByRole("button", { name: "用于对话", exact: true }).click();
  await page.getByRole("button", { name: "创建对话", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\/\d+$/);
  await expect(page.getByRole("button", { name: "移除 notes.txt" })).toBeVisible();
});
