/**
 * 把点播/直播地址交给本机 PotPlayer。
 *
 * 浏览器不能把 PotPlayer 嵌进页面，只能走它在 Windows 上注册的 potplayer:// 协议，
 * 或下载一份 .dpl 播放列表，由用户用 PotPlayer 打开。两种方式都使用原始媒体地址：
 * PotPlayer 不会带上本站登录 cookie，/api/proxy 对它不可用。
 */

export interface PlaylistItem {
  url: string;
  title: string;
}

export function isDirectMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Windows 桌面。Windows Phone 不算，PotPlayer 没有移动版。 */
export function looksLikeWindows(ua: string, platform = ''): boolean {
  if (/Windows Phone/i.test(ua)) return false;
  if (/Win(?:32|64)/i.test(platform)) return true;
  return /Windows NT/i.test(ua);
}

/**
 * potplayer:// 后面整段都是媒体地址。
 * encodeURI 保留查询串里的 &，同时把空格和 # 处理掉，避免被协议截断。
 */
export function potPlayerHref(mediaUrl: string): string | null {
  if (!isDirectMediaUrl(mediaUrl)) return null;
  return `potplayer://${encodeURI(mediaUrl).replace(/#/g, '%23')}`;
}

function dplUrl(url: string): string {
  return url.replace(/\*/g, '%2A').replace(/[\r\n]/g, '');
}

function dplTitle(title: string): string {
  const cleaned = title.replace(/[\r\n*]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || '未命名';
}

/** PotPlayer 播放列表。没有可用地址时返回 null，避免下载空文件。 */
export function buildPotPlayerPlaylist(items: PlaylistItem[]): string | null {
  const rows = items.filter((item) => isDirectMediaUrl(item.url));
  if (rows.length === 0) return null;
  const lines = ['DAUMPLAYLIST', 'playname=LibreTV', 'topindex=0', 'saveplaypos=0'];
  rows.forEach((item, index) => {
    const n = index + 1;
    lines.push(`${n}*file*${dplUrl(item.url)}`);
    lines.push(`${n}*title*${dplTitle(item.title)}`);
    lines.push(`${n}*played*0`);
  });
  return `${lines.join('\r\n')}\r\n`;
}

export function playlistFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'LibreTV'}.dpl`;
}

export function openPotPlayer(mediaUrl: string): boolean {
  if (typeof document === 'undefined') return false;
  const href = potPlayerHref(mediaUrl);
  if (!href) return false;
  const a = document.createElement('a');
  a.setAttribute('href', href);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

export function downloadPotPlayerPlaylist(title: string, items: PlaylistItem[]): boolean {
  if (typeof document === 'undefined') return false;
  const body = buildPotPlayerPlaylist(items);
  if (!body) return false;
  const blob = new Blob([body], { type: 'application/octet-stream' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = playlistFilename(title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return true;
}
