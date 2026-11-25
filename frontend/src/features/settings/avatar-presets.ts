import chefAvatar from "./avatars/nailong-chef.webp";
import cheerAvatar from "./avatars/nailong-cheer.webp";
import coolAvatar from "./avatars/nailong-cool.webp";
import flowerAvatar from "./avatars/nailong-flower.webp";
import musicAvatar from "./avatars/nailong-music.webp";
import sleepAvatar from "./avatars/nailong-sleep.webp";
import smileAvatar from "./avatars/nailong-smile.webp";
import snackAvatar from "./avatars/nailong-snack.webp";
import spaceAvatar from "./avatars/nailong-space.webp";
import studyAvatar from "./avatars/nailong-study.webp";
import surpriseAvatar from "./avatars/nailong-surprise.webp";
import winkAvatar from "./avatars/nailong-wink.webp";

export type AvatarPreset = { id: string; label: string; src: string };

/** 奶龙预设头像。固定展示顺序，图片 URL 随构建生成。 */
export const avatarPresets: readonly AvatarPreset[] = [
  { id: "nailong-smile", label: "开心奶龙", src: smileAvatar },
  { id: "nailong-wink", label: "眨眼奶龙", src: winkAvatar },
  { id: "nailong-sleep", label: "打盹奶龙", src: sleepAvatar },
  { id: "nailong-surprise", label: "惊喜奶龙", src: surpriseAvatar },
  { id: "nailong-cool", label: "酷酷奶龙", src: coolAvatar },
  { id: "nailong-cheer", label: "加油奶龙", src: cheerAvatar },
  { id: "nailong-snack", label: "吃货奶龙", src: snackAvatar },
  { id: "nailong-study", label: "学霸奶龙", src: studyAvatar },
  { id: "nailong-space", label: "宇航奶龙", src: spaceAvatar },
  { id: "nailong-chef", label: "厨师奶龙", src: chefAvatar },
  { id: "nailong-flower", label: "花花奶龙", src: flowerAvatar },
  { id: "nailong-music", label: "音乐奶龙", src: musicAvatar }
];
