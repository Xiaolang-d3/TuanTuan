import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function typeEmail(input: HTMLElement, value: string) {
  act(() => input.focus());
  fireEvent.input(input, { target: { value }, inputType: "insertText" });
}

function activeOption(input: HTMLElement) {
  return document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
}

describe("AuthEmailInput", () => {
  afterEach(cleanup);

  it("suggests common domains without changing the typed account until chosen", async () => {
    const submit = vi.fn();
    render(<EmailForm onSubmit={submit} />);
    const input = screen.getByRole("combobox", { name: "邮箱" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    typeEmail(input, "reader");
    expect(await screen.findAllByRole("option")).toHaveLength(6);
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
  ])("completes the partial suffix of %s", async (domain) => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    typeEmail(input, `reader@${domain.slice(0, -1).toUpperCase()}`);
    fireEvent.click(await screen.findByRole("option", { name: `reader@${domain}` }));
    expect(input).toHaveValue(`reader@${domain}`);
  });

  it("selects with arrows and Enter without submitting the form", async () => {
    const submit = vi.fn();
    render(<EmailForm onSubmit={submit} />);
    const input = screen.getByLabelText("邮箱");
    typeEmail(input, "reader@");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(activeOption(input)).toHaveTextContent("reader@qq.com"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(activeOption(input)).toHaveTextContent("reader@163.com"));
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(input).toHaveValue("reader@163.com");
    expect(submit).not.toHaveBeenCalled();
  });

  it("dismisses suggestions without completing on Escape or moving focus", async () => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    const submit = screen.getByRole("button", { name: "注册" });
    typeEmail(input, "reader@");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(activeOption(input)).toHaveTextContent("reader@icloud.com"));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveValue("reader@");
    expect(input).toHaveFocus();
    typeEmail(input, "reader@q");
    await screen.findByRole("listbox");
    act(() => submit.focus());
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveValue("reader@q");
  });

  it("does not force a suggestion on Enter or interfere with composed text", async () => {
    render(<EmailForm />);
    const input = screen.getByLabelText("邮箱");
    typeEmail(input, "reader@");
    await screen.findByRole("listbox");
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
      typeEmail(input, value);
      expect(input).toHaveValue(value);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    }
  });
});
