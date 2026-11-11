import type { AvatarPreset } from "./avatar-presets";

/** 预设头像上传前的统一尺寸（正方形，PNG）。 */
export const avatarRasterSize = 512;

const loadErrorMessage = "头像素材加载失败";
const canvasErrorMessage = "当前环境无法处理头像";
const encodeErrorMessage = "头像生成失败";

async function fetchAvatarBlob(src: string): Promise<Blob> {
  try {
    const response = await fetch(src, { cache: "force-cache" });
    // 只把明确的失败响应当作错误，便于测试与静态托管环境替换 fetch。
    if (response.ok === false) throw new Error(loadErrorMessage);
    return await response.blob();
  } catch {
    throw new Error(loadErrorMessage);
  }
}

/**
 * 优先用 decode()（能拿到解码后的位图再绘制），
 * 环境不支持 decode 时回退到 onload/onerror。
 */
async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = url;
  if (typeof image.decode === "function") {
    try {
      await image.decode();
      return image;
    } catch {
      throw new Error(loadErrorMessage);
    }
  }
  if (!(await loaded)) throw new Error(loadErrorMessage);
  return image;
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error(encodeErrorMessage));
    }, "image/png");
  });
}

/**
 * 把预设 SVG 光栅化成 512×512 的 PNG File，交给现有头像上传接口（PNG 在允许类型内）。
 */
export async function presetAvatarFile(preset: AvatarPreset): Promise<File> {
  const blob = await fetchAvatarBlob(preset.src);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await decodeImage(objectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = avatarRasterSize;
    canvas.height = avatarRasterSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(canvasErrorMessage);
    context.drawImage(image, 0, 0, avatarRasterSize, avatarRasterSize);
    const png = await encodePng(canvas);
    return new File([png], `${preset.id}.png`, { type: "image/png" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
