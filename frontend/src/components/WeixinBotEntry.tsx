import { Bot } from 'lucide-react';
import './weixin-bot-entry.css';

export function WeixinBotEntry({ active, unreadCount, enabled, error, onOpen }: {
  active: boolean; unreadCount: number; enabled: boolean;
  error: string; onOpen: () => void;
}) {
  const status = !enabled ? 'disconnected' : error ? 'warning' : 'connected';
  const label = !enabled ? '连接已失效' : error ? '连接异常' : '已连接';
  const accessible = `微信 Bot，${label}${unreadCount > 0 ? `，${unreadCount} 条未读消息` : ''}`;
  return <button type="button" className={`weixin-bot-entry${active ? ' active' : ''}`} data-status={status}
    onClick={onOpen} aria-label={accessible} aria-current={active ? 'page' : undefined} title={accessible}>
    <Bot size={20} aria-hidden="true" />
    <span className="weixin-bot-status" aria-hidden="true" />
  </button>;
}
