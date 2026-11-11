'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon';
import { useToast } from './toast';
import { cn } from '@/lib/utils';
import {
  downloadPotPlayerPlaylist,
  isDirectMediaUrl,
  looksLikeWindows,
  openPotPlayer,
  type PlaylistItem,
} from '@/lib/potplayer';

/**
 * Windows 桌面把当前地址交给 PotPlayer。
 * 其他系统没有这个协议，按钮不出现。
 */
export function PotPlayerButton({
  url,
  title,
  playlist,
  variant = 'toolbar',
}: {
  url: string;
  title: string;
  playlist?: PlaylistItem[];
  variant?: 'toolbar' | 'icon';
}) {
  const { toast } = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setReady(looksLikeWindows(navigator.userAgent || '', navigator.platform || ''));
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!ready || !isDirectMediaUrl(url)) return null;
  const items = (playlist && playlist.length > 0 ? playlist : [{ url, title }]).filter((item) => isDirectMediaUrl(item.url));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={variant === 'icon'
          ? 'rounded-md p-2 text-muted hover:text-accent hover:bg-hover transition-colors'
          : 'watch-action'}
        aria-expanded={open}
        aria-haspopup="menu"
        title="用 PotPlayer 打开"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="play" className="w-4 h-4" />
        {variant === 'toolbar' && <span>PotPlayer</span>}
        {variant === 'icon' && <span className="sr-only">用 PotPlayer 打开</span>}
      </button>
      {open && (
        <div role="menu" className={cn('watch-potplayer-menu', variant === 'icon' && 'is-end')}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              if (openPotPlayer(url)) toast('正在打开 PotPlayer', 'info');
              else toast('这个地址不能交给 PotPlayer', 'error');
            }}
          >
            播放当前
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              if (downloadPotPlayerPlaylist(title, items)) {
                toast(items.length > 1 ? `已下载 ${items.length} 集播放列表` : '已下载播放列表', 'success');
              } else toast('没有可以写入列表的地址', 'error');
            }}
          >
            {items.length > 1 ? `下载整季列表（${items.length}）` : '下载播放列表'}
          </button>
          <p>PotPlayer 用你的电脑直接打开原始地址，不走网站代理。没反应就确认已经安装，并用它打开刚下载的列表。</p>
        </div>
      )}
    </div>
  );
}
