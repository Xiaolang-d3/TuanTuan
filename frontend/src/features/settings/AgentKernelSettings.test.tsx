import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentKernelSettings } from "./AgentKernelSettings";

const choices = [
  { id: "tuantuan" as const, name: "团团内核", available: true, reason: "" },
  { id: "dsh" as const, name: "DeepSeek Harness", available: true, reason: "" }
];

describe("AgentKernelSettings", () => {
  it("saves the selected default kernel", () => {
    const onChange = vi.fn();
    render(<AgentKernelSettings choices={choices} defaultKernel="tuantuan" busy={false} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("新对话默认内核"), { target: { value: "dsh" } });

    expect(onChange).toHaveBeenCalledWith("dsh");
  });

  it("explains the fallback when the saved default is unavailable", () => {
    render(
      <AgentKernelSettings
        choices={[choices[0], { ...choices[1], available: false, reason: "需要先添加并启用 DeepSeek 模型档案" }]}
        defaultKernel="dsh"
        busy={false}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("新对话会先使用团团内核");
  });
});
