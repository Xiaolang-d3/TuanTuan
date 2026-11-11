export type AvatarPreset = { id: string; label: string; src: string };

/**
 * 奶龙预设头像。src 指向 frontend/public/avatars/ 下的自包含 SVG，
 * 文件名与 id 一致，顺序与设计契约表格保持一致（方便页面按固定顺序展示）。
 */
export const avatarPresets: readonly AvatarPreset[] = [
  { id: "nailong-smile", label: "开心奶龙", src: "/avatars/nailong-smile.svg" },
  { id: "nailong-wink", label: "眨眼奶龙", src: "/avatars/nailong-wink.svg" },
  { id: "nailong-sleep", label: "打盹奶龙", src: "/avatars/nailong-sleep.svg" },
  { id: "nailong-surprise", label: "惊喜奶龙", src: "/avatars/nailong-surprise.svg" },
  { id: "nailong-cool", label: "酷酷奶龙", src: "/avatars/nailong-cool.svg" },
  { id: "nailong-cheer", label: "加油奶龙", src: "/avatars/nailong-cheer.svg" },
  { id: "nailong-snack", label: "吃货奶龙", src: "/avatars/nailong-snack.svg" },
  { id: "nailong-study", label: "学霸奶龙", src: "/avatars/nailong-study.svg" },
  { id: "nailong-space", label: "宇航奶龙", src: "/avatars/nailong-space.svg" },
  { id: "nailong-chef", label: "厨师奶龙", src: "/avatars/nailong-chef.svg" },
  { id: "nailong-flower", label: "花花奶龙", src: "/avatars/nailong-flower.svg" },
  { id: "nailong-music", label: "音乐奶龙", src: "/avatars/nailong-music.svg" }
];
