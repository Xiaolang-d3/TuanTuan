import { afterEach, describe, expect, it, vi } from "vitest";
import { avatarRasterSize, presetAvatarFile } from "./avatar-raster";
import type { AvatarPreset } from "./avatar-presets";

const preset: AvatarPreset = { id: "nailong-smile", label: "开心奶龙", src: "/assets/nailong-smile.webp" };

const objectUrl = "blob:preset-1";

function stubFetch(ok = true) {
  const blob = new Blob(["webp"], { type: "image/webp" });
  const fetchMock = vi.fn(async () => (
    ok
      ? { ok: true, status: 200, blob: async () => blob }
      : { ok: false, status: 404, blob: async () => new Blob([], { type: "text/plain" }) }
  ));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, blob };
}

function stubObjectUrl() {
  const createObjectURL = vi.fn(() => objectUrl);
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

type ImageOptions = {
  /** "ok" 提供可用的 decode()；"fail" 提供会拒绝的 decode()；省略则模拟不支持 decode。 */
  decode?: "ok" | "fail";
  load?: "onload" | "onerror";
};

type StubbedImage = {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
  decode?: () => Promise<void>;
  naturalWidth: number;
  naturalHeight: number;
};

function stubImage(options: ImageOptions = {}) {
  const created: StubbedImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 360;
    naturalHeight = 360;
    decode?: () => Promise<void>;
    currentSrc = "";

    constructor() {
      if (options.decode === "ok") this.decode = () => Promise.resolve();
      if (options.decode === "fail") this.decode = () => Promise.reject(new Error("decode broke"));
      created.push(this);
    }

    get src() {
      return this.currentSrc;
    }

    set src(value: string) {
      this.currentSrc = value;
      // 只有不支持 decode 的路径才依赖 load 事件。
      if (this.decode) return;
      const event = options.load ?? "onload";
      queueMicrotask(() => {
        if (event === "onerror") this.onerror?.();
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
  return created;
}

type CanvasOptions = { context?: boolean; png?: Blob | null };

function stubCanvas(options: CanvasOptions = {}) {
  const drawImage = vi.fn();
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    (options.context === false ? null : { drawImage }) as unknown as CanvasRenderingContext2D
  );
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string
  ) {
    expect(this.width).toBe(avatarRasterSize);
    expect(this.height).toBe(avatarRasterSize);
    expect(type).toBe("image/png");
    callback(options.png === undefined ? new Blob(["png"], { type: "image/png" }) : options.png);
  });
  return { drawImage, getContext, toBlob };
}

describe("presetAvatarFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("converts a preset WebP into a square PNG File", async () => {
    expect(avatarRasterSize).toBe(512);
    const { fetchMock, blob } = stubFetch();
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    const images = stubImage({ decode: "ok" });
    const { drawImage, toBlob } = stubCanvas();

    const file = await presetAvatarFile(preset);

    expect(fetchMock).toHaveBeenCalledWith(preset.src, { cache: "force-cache" });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(images[0].src).toBe(objectUrl);
    expect(drawImage).toHaveBeenCalledWith(images[0], 0, 0, avatarRasterSize, avatarRasterSize);
    expect(toBlob).toHaveBeenCalledOnce();
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("nailong-smile.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBeGreaterThan(0);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("falls back to the load event when decode() is unavailable", async () => {
    stubFetch();
    stubObjectUrl();
    const images = stubImage({ load: "onload" });
    const { drawImage } = stubCanvas();

    const file = await presetAvatarFile(preset);

    expect(images[0].decode).toBeUndefined();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(file.name).toBe("nailong-smile.png");
  });

  it("reports the load error message when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { createObjectURL } = stubObjectUrl();

    await expect(presetAvatarFile(preset)).rejects.toThrow("头像素材加载失败");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("reports the load error message when the asset responds with a failure status", async () => {
    stubFetch(false);
    stubObjectUrl();

    await expect(presetAvatarFile(preset)).rejects.toThrow("头像素材加载失败");
  });

  it("reports the load error message and releases the object url when decoding fails", async () => {
    stubFetch();
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubImage({ decode: "fail" });

    await expect(presetAvatarFile(preset)).rejects.toThrow("头像素材加载失败");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("reports the load error message when the image emits an error in the fallback path", async () => {
    stubFetch();
    const { revokeObjectURL } = stubObjectUrl();
    stubImage({ load: "onerror" });

    await expect(presetAvatarFile(preset)).rejects.toThrow("头像素材加载失败");
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("reports the canvas error message when 2d context is missing", async () => {
    stubFetch();
    const { revokeObjectURL } = stubObjectUrl();
    stubImage({ decode: "ok" });
    const { toBlob } = stubCanvas({ context: false });

    await expect(presetAvatarFile(preset)).rejects.toThrow("当前环境无法处理头像");
    expect(toBlob).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("reports the encode error message when toBlob yields nothing", async () => {
    stubFetch();
    const { revokeObjectURL } = stubObjectUrl();
    stubImage({ decode: "ok" });
    stubCanvas({ png: null });

    await expect(presetAvatarFile(preset)).rejects.toThrow("头像生成失败");
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });
});
