import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QqGroupEntry, qqGroupLink, qqGroupNumber } from "./QqGroupEntry";

describe("QqGroupEntry", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the group number, QR code and join link when opened", () => {
    render(<QqGroupEntry />);
    const trigger = screen.getByRole("button", { name: "交流群" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(`QQ 群号：${qqGroupNumber}`)).toBeTruthy();
    expect(screen.getByRole("img", { name: "团团交流群 QQ 二维码" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "团团交流群" });
    expect(link.getAttribute("href")).toBe("https://qm.qq.com/q/s8FpW2CnHa");
    expect(qqGroupLink).toBe("https://qm.qq.com/q/s8FpW2CnHa");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<QqGroupEntry />);
    const trigger = screen.getByRole("button", { name: "交流群" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("copies the group number", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<QqGroupEntry />);
    fireEvent.click(screen.getByRole("button", { name: "交流群" }));
    fireEvent.click(screen.getByRole("button", { name: "复制群号" }));
    expect(await screen.findByRole("button", { name: "已复制群号" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("1129343230");
  });
});
