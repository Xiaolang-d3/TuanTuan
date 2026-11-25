import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./ChatMarkdown";

vi.mock("../../components/ChatWorkspaceMermaid", () => ({ ChatWorkspaceMermaid: ({ source }: { source: string }) => <div aria-label="Mermaid 图">{source}</div> }));
vi.mock("../../components/ChatWorkspaceMindmap", () => ({ ChatWorkspaceMindmap: ({ source }: { source: string }) => <div aria-label="思维导图">{source}</div> }));

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

const fenced = (language: string, lines: string[]) => `~~~${language}\n${lines.join("\n")}\n~~~`;

it("renders bound web references as source chips and keeps other links separate", () => {
  const url = "https://example.com/report?a=1&b=2";
  render(<MarkdownContent sources={[{ url, title: "报告", domain: "example.com" }]}>
    {"[来源](<https://example.com/report?a=1&amp;b=2>) 和 [其他网站](https://other.example)"}
  </MarkdownContent>);
  expect(screen.getByRole("link", { name: "来源 1：报告" })).toHaveAttribute("href", url);
  expect(screen.getByRole("link", { name: "其他网站" })).not.toHaveClass("md-citation");
});

it("numbers fenced lines without modifying copied code or inline code", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const lines = ["  const count = 1;  ", "", "  count + 1;", ""];
  const { container } = render(<MarkdownContent>{`行内 \`count\`\n\n${fenced("js", lines)}`}</MarkdownContent>);
  expect(container.querySelector("p code")).toHaveTextContent("count");
  expect([...container.querySelectorAll("[data-line-number]")].map(node => node.getAttribute("data-line-number"))).toEqual(["1", "2", "3", "4"]);
  expect(container.querySelector("pre code")?.textContent).toBe(`${lines.join("\n")}\n`);
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  expect(await screen.findByRole("button", { name: "已复制" })).toBeVisible();
  expect(writeText).toHaveBeenCalledWith(`${lines.join("\n")}\n`);
});

it("classifies explicit and canonical unified diffs but not ordinary plus/minus code", () => {
  const patch = ["--- a/example", "+++ b/example", "@@ -1,2 +1,2 @@", "--- removed content", "+++ added content", " context"];
  const { container } = render(<MarkdownContent>{[
    fenced("diff", patch), fenced("", patch), fenced("patch", ["-before", "+after"]), fenced("js", ["+counter", "-counter"]), fenced("", ["+counter", "-counter"]),
  ].join("\n\n")}</MarkdownContent>);
  const kinds = (block: Element) => [...block.querySelectorAll(".chat-code-line")].map(line => line.getAttribute("data-diff-kind"));
  const [explicit, inferred, shorthand, ordinary, untagged] = container.querySelectorAll("pre");
  const unified = ["metadata", "metadata", "metadata", "deletion", "addition", null];
  expect(kinds(explicit)).toEqual(unified);
  expect(kinds(inferred)).toEqual(unified);
  expect(kinds(shorthand)).toEqual(["deletion", "addition"]);
  expect(kinds(ordinary)).toEqual([null, null]);
  expect(kinds(untagged)).toEqual([null, null]);
});

it("shows copy errors and preserves long-block expansion and streaming behavior", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const code = fenced("text", Array.from({ length: 25 }, (_, index) => `line ${index + 1}`));
  const { rerender } = render(<MarkdownContent streaming>{code}</MarkdownContent>);
  expect(screen.getByRole("button", { name: "下载代码" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /展开完整代码/ })).not.toBeInTheDocument();
  rerender(<MarkdownContent>{code}</MarkdownContent>);
  const toggle = screen.getByRole("button", { name: "展开完整代码（25 行）" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "收起代码" })).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("复制失败，请重试"));
});

it("does not wrap Mermaid or mindmap blocks with code controls", () => {
  const { container } = render(<MarkdownContent>{[fenced("mermaid", ["graph TD", "A --> B"]), fenced("mermaid", ["mindmap", "  root((开始))"])].join("\n\n")}</MarkdownContent>);
  expect(screen.getByLabelText("Mermaid 图")).toHaveTextContent("A --> B");
  expect(screen.getByLabelText("思维导图")).toHaveTextContent("root((开始))");
  expect(container.querySelector(".chat-code-block")).toBeNull();
});
