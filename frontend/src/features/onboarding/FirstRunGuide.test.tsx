import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunGuide } from "./FirstRunGuide";
import { firstRunStorageKey, useFirstRun } from "./useFirstRun";

function setup() {
  const props = {
    onDismiss: vi.fn(),
    onOpenModelSettings: vi.fn(),
    onOpenLibrary: vi.fn()
  };
  render(<FirstRunGuide {...props} />);
  return props;
}

describe("FirstRunGuide", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("explains the three starting steps", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "先接上模型，再让它开始干活" })).toBeInTheDocument();
    expect(screen.getByText("接上你的模型")).toBeInTheDocument();
    expect(screen.getByText("它是这么干活的")).toBeInTheDocument();
    expect(screen.getByText("资料留给下一次")).toBeInTheDocument();
    expect(screen.getByText(/团团不自带模型/)).toBeInTheDocument();
  });

  it("focuses the model setup action first", () => {
    setup();
    expect(screen.getByRole("button", { name: /去配置模型/ })).toHaveFocus();
  });

  it("routes to model settings or the library", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /去配置模型/ }));
    expect(props.onOpenModelSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /打开文件库/ }));
    expect(props.onOpenLibrary).toHaveBeenCalledOnce();
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it("can be skipped from the close button, the footer, or Escape", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "跳过新手指引" }));
    fireEvent.click(screen.getByRole("button", { name: /先看看，开始使用/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onDismiss).toHaveBeenCalledTimes(3);
  });
});

describe("useFirstRun", () => {
  beforeEach(() => localStorage.clear());

  it("starts visible, hides after completion, and stays hidden on remount", () => {
    const first = renderHook(() => useFirstRun("user@example.test"));
    expect(first.result.current.shouldShow).toBe(true);
    act(() => first.result.current.complete());
    expect(first.result.current.shouldShow).toBe(false);
    expect(localStorage.getItem(firstRunStorageKey("user@example.test"))).toBe("done");
    first.unmount();

    const again = renderHook(() => useFirstRun("user@example.test"));
    expect(again.result.current.shouldShow).toBe(false);
  });

  it("keeps the guide per account", () => {
    const one = renderHook(() => useFirstRun("one@example.test"));
    act(() => one.result.current.complete());
    const other = renderHook(() => useFirstRun("two@example.test"));
    expect(other.result.current.shouldShow).toBe(true);
  });
});
