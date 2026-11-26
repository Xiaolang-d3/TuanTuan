import { useState } from "react";
import readingRoom from "./inspiration/reading-room.webp";
import skincare from "./inspiration/skincare.webp";
import treasureChests from "./inspiration/treasure-chests.webp";

const categories = ["为你推荐", "游戏美术", "电商设计", "海报", "短视频"] as const;
type Category = (typeof categories)[number];

const examples = [
  { category: "游戏美术", title: "游戏场景设计", image: readingRoom, prompt: "画一张等距视角的治愈系游戏场景。暖色阁楼里有窗边书架、木地板和一张小床，一位角色坐在床上读书。用细密线稿和柔和的午后阳光表现空间层次。" },
  { category: "电商设计", title: "商品宣传设计", image: skincare, prompt: "为一款护肤精华制作竖版产品图。浅鼠尾草绿的滴管瓶和纸盒摆在浅绿背景前，搭配圆形绿叶与柔和侧光，突出磨砂玻璃和纸盒的材质。" },
  { category: "游戏美术", title: "游戏道具创作", image: treasureChests, prompt: "设计一组 3D 奇幻游戏道具。用冷灰背景陈列一组橡木宝箱、发光的黄铜提灯和散落的彩色小饰品，以柔光突出木纹和金属铆钉。" },
  { category: "海报", title: "阅读主题海报", image: readingRoom, prompt: "制作一张竖版阅读主题海报。用暖色插画表现午后阁楼和正在读书的人，在画面上方留出标题区，底部留出活动信息区。" },
  { category: "短视频", title: "商品短片分镜", image: skincare, prompt: "为一款护肤精华绘制四格短视频分镜。按纸盒亮相、滴管瓶特写、精华滴落、全套产品定格的顺序构图，贯穿浅绿布景和自然柔光。" },
] as const;

export function CreationInspiration({ onChoose }: { onChoose: (prompt: string) => void }) {
  const [category, setCategory] = useState<Category>("为你推荐");
  const visible = category === "为你推荐" ? examples.slice(0, 3) : examples.filter(item => item.category === category);
  return <section className="creation-inspiration" aria-labelledby="creation-inspiration-title">
    <h2 id="creation-inspiration-title">探索创作灵感</h2>
    <div className="creation-inspiration-filters" role="group" aria-label="灵感分类">
      {categories.map(item => <button key={item} type="button" aria-pressed={item === category} onClick={() => setCategory(item)}>{item}</button>)}
    </div>
    <div className="creation-inspiration-grid">
      {visible.map(item => <button className="creation-inspiration-card" type="button" key={item.title} onClick={() => onChoose(item.prompt)}>
        <img src={item.image} alt="" width={576} height={768} />
        <span>{item.title}</span>
      </button>)}
    </div>
  </section>;
}
