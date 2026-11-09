import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PresentationPageImage } from "./PresentationPageImage";
import type { PresentationService } from "./presentation-service";

beforeEach(() => vi.stubGlobal("URL", class extends URL { static revokeObjectURL = vi.fn(); }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const artifact = { id: "page-1", version: 1, filename: "P01.png", size: 10, media_type: "image/png" };

it("does not fetch an offscreen thumbnail, then cancels and releases its late response", async () => {
  let visibility!: IntersectionObserverCallback;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { visibility = callback; }
    observe = observe; disconnect = disconnect;
  });
  let finish!: (url: string) => void;
  const preview = vi.fn((_artifact: typeof artifact, _signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve; }));
  const service = { preview } as unknown as PresentationService;
  const result = render(<PresentationPageImage service={service} artifact={artifact} page={1} thumbnail />);
  expect(observe).toHaveBeenCalledOnce();
  expect(preview).not.toHaveBeenCalled();
  act(() => visibility([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(preview).toHaveBeenCalledWith(artifact, expect.any(AbortSignal));
  const signal = preview.mock.calls[0][1];
  result.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish("blob:late"));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:late");
  expect(disconnect).toHaveBeenCalled();
});

it("keeps thumbnail failures noninteractive and supports retry in the full page", async () => {
  const preview = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("blob:page");
  const service = { preview } as unknown as PresentationService;
  const result = render(<PresentationPageImage service={service} artifact={artifact} page={1} thumbnail />);
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  result.unmount();
  render(<PresentationPageImage service={service} artifact={artifact} page={1} />);
  const image = await screen.findByAltText("第 1 页预览");
  fireEvent.error(image);
  fireEvent.click(screen.getByRole("button", { name: "重新读取预览" }));
  await screen.findByAltText("第 1 页预览");
  expect(preview).toHaveBeenCalledTimes(3);
});
