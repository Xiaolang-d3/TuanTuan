import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelPicker, type KernelChoice } from "./KernelPicker";

const choices: KernelChoice[] = [
  { id: "tuantuan", name: "团团内核", available: true, reason: "" },
  { id: "dsh", name: "DeepSeek Harness", available: false, reason: "需要先添加 DeepSeek 模型连接" },
];

function setup(overrides: Partial<Parameters<typeof KernelPicker>[0]> = {}) {
  const props = {
    choices, selected: "tuantuan", locked: false, busy: false, onChange: vi.fn(), ...overrides,
  };
  const view = render(<KernelPicker {...props} />);
  return { ...props, view };
}

afterEach(cleanup);

describe("KernelPicker", () => {
  it("selects an available kernel and reports the change", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /团团内核/ }));
    fireEvent.click(screen.getByRole("option", { name: "团团内核" }));
    expect(onChange).toHaveBeenCalledWith("tuantuan");
  });

  it("disables unavailable kernels and explains the reason", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /团团内核/ }));
    expect(screen.getByRole("option", { name: /DeepSeek Harness/ })).toBeDisabled();
    expect(screen.getByText("需要先添加 DeepSeek 模型连接")).toBeInTheDocument();
  });

  it("renders a read-only badge when the conversation is locked", () => {
    setup({ locked: true, selected: "dsh" });
    const badge = screen.getByRole("button", { name: /DeepSeek Harness/ });
    expect(badge).toHaveAttribute("title", "内核在对话创建后不可更改，可新建对话换内核");
    fireEvent.click(badge);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
});
