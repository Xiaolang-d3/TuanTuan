import { MessageCircle, Settings, Video } from "lucide-react";
export { WorksPage } from "./WorksPage";
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
