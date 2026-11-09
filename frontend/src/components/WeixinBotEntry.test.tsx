import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WeixinBotEntry } from './WeixinBotEntry';

afterEach(cleanup);
it.each([
  [true, '', 'connected', '已连接'],
  [true, '网络错误', 'warning', '连接异常'],
  [false, '', 'disconnected', '连接已失效'],
  [false, '登录过期', 'disconnected', '连接已失效']
] as const)('shows an icon with accessible connection status (%s, %s)', (enabled, error, status, label) => {
  const onOpen = vi.fn();
  render(<WeixinBotEntry active={false} unreadCount={108} enabled={enabled} error={error} onOpen={onOpen} />);
  const button = screen.getByRole('button', { name: `微信 Bot，${label}，108 条未读消息` });
  expect(button).toHaveAttribute('title', `微信 Bot，${label}，108 条未读消息`);
  expect(button).toHaveAttribute('data-status', status);
  expect(button.textContent).toBe('');
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});
