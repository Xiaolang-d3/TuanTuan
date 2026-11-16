import { GalleryThumbnails, Image, Library, MessageCircle, Settings, Video } from "lucide-react";
import type { ReactNode } from "react";
import "./product-pages.css";

export type ProductPageProps = {
  onOpenChat: () => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
};

function Page({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="product-page" aria-label={title}>
      <div className="product-page-content">
        <div className="product-page-icon" aria-hidden="true">{icon}</div>
        <h1>{title}</h1>
        {children}
      </div>
    </section>
  );
}

export function ImagePage({ onOpenChat, onOpenSettings }: ProductPageProps) {
  return (
    <Page title="图片" icon={<Image size={24} />}>
      <p className="product-page-lead">在对话中把想法变成图片。</p>
      <div className="product-page-details">
        <h2>现在可以做什么</h2>
        <p>可以在对话中生成图片，也可以编辑对话中生成的图片。</p>
        <p>上传任意图片后直接编辑尚未支持。</p>
      </div>
      <div className="product-page-actions">
        <button className="product-page-primary" type="button" onClick={onOpenChat}><MessageCircle size={16} aria-hidden="true" />进入对话</button>
        <button type="button" onClick={onOpenSettings}><Settings size={16} aria-hidden="true" />打开设置</button>
      </div>
    </Page>
  );
}

export function VideoPage({ onOpenChat, onOpenSettings }: ProductPageProps) {
  return (
    <Page title="视频" icon={<Video size={24} />}>
      <p className="product-page-lead">视频生成尚未接入。</p>
      <div className="product-page-details">
        <h2>当前状态</h2>
        <p>图生视频的首版范围待定，目前还不能在这里生成视频。</p>
      </div>
      <div className="product-page-actions">
        <button className="product-page-primary" type="button" onClick={onOpenChat}><MessageCircle size={16} aria-hidden="true" />返回对话</button>
        <button type="button" onClick={onOpenSettings}><Settings size={16} aria-hidden="true" />打开设置</button>
      </div>
    </Page>
  );
}

export function WorksPage({ onOpenChat, onOpenLibrary }: ProductPageProps) {
  return (
    <Page title="我的作品" icon={<GalleryThumbnails size={24} />}>
      <p className="product-page-lead">集中作品管理尚未接入。</p>
      <div className="product-page-details">
        <h2>继续使用</h2>
        <p>可以前往文件库查看已保存的文件，或返回对话继续工作。</p>
      </div>
      <div className="product-page-actions">
        <button className="product-page-primary" type="button" onClick={onOpenLibrary}><Library size={16} aria-hidden="true" />打开文件库</button>
        <button type="button" onClick={onOpenChat}><MessageCircle size={16} aria-hidden="true" />返回对话</button>
      </div>
    </Page>
  );
}
