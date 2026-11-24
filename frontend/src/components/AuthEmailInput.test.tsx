import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthEmailInput } from "./AuthEmailInput";

function EmailForm({ onSubmit = () => undefined }: { onSubmit?: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(email); }}>
      <AuthEmailInput value={email} registering disabled={false} inputRef={inputRef} onChange={setEmail} />
      <button type="submit">注册</button>
    </form>
  );
}

describe("AuthEmailInput", () => {
  afterEach(cleanup);

  it("suggests common domains without changing the typed account until chosen", () => {
    const submit = vi.fn();
    render(<EmailForm onSubmit={submit} />);
    const input = screen.getByRole("combobox", { name: "邮箱" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "reader" } });
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(input).toHaveValue("reader");
    expect(input).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("option", { name: "reader@qq.com" }));
    expect(input).toHaveValue("reader@qq.com");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    "qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "icloud.com",
    "hotmail.com", "foxmail.com", "yeah.net", "sina.com", "sina.cn", "sohu.com", "yahoo.com"
  ])("completes the partial suffix of %s", (domain) => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    fireEvent.change(input, { target: { value: `reader@${domain.slice(0, -1).toUpperCase()}` } });
    fireEvent.click(screen.getByRole("option", { name: `reader@${domain}` }));
    expect(input).toHaveValue(`reader@${domain}`);
  });

  it("selects with arrows and Enter without submitting the form", () => {
    const submit = vi.fn();
    render(<EmailForm onSubmit={submit} />);
    const input = screen.getByLabelText("邮箱");
    fireEvent.change(input, { target: { value: "reader@" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "auth-email-option-0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "reader@163.com" })).toHaveAttribute("aria-selected", "true");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(input).toHaveValue("reader@163.com");
    expect(submit).not.toHaveBeenCalled();
  });

  it("dismisses suggestions without completing on Escape, Tab or blur", () => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    fireEvent.change(input, { target: { value: "reader@" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", "auth-email-option-5");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "auth-email-option-0");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("reader@");
  });

  it("does not force a suggestion on Enter or interfere with composed text", () => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    fireEvent.change(input, { target: { value: "reader@" } });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(input).toHaveValue("reader@");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("reader@");
  });

  it("preserves complete and custom addresses and hides suggestions for invalid names", () => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    for (const value of ["reader@qq.com", "reader@company.cn", "reader@unknown", "reader name@", "reader@@", "@qq", "r".repeat(320)]) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveValue(value);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    }
  });
});
