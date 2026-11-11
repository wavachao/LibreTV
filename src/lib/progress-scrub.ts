/**
 * 进度条按手指所在的位置跳转，而不是按滑动距离估一段。
 * 手机上 ArtPlayer 只给进度条做了相对手势，薄条上很难拖到任意时间。
 */

export function scrubRatio(
  x: number,
  y: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const vx = end.x - start.x;
  const vy = end.y - start.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1) return 0;
  const t = ((x - start.x) * vx + (y - start.y) * vy) / len2;
  return Math.min(1, Math.max(0, t));
}

export function scrubDuration(video: {
  duration: number;
  seekable?: { length: number; end: (index: number) => number };
}): number {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  try {
    const count = video.seekable?.length ?? 0;
    if (count > 0) {
      const end = video.seekable!.end(count - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
  } catch {
    /* seekable 在部分浏览器上会抛 */
  }
  return 0;
}

export function scrubTime(ratio: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, ratio)) * Math.max(0, duration - 0.05);
}

function pointAt(inner: HTMLElement, ratio: number): { x: number; y: number } {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;left:${ratio * 100}%;top:50%;width:0;height:0;pointer-events:none;`;
  inner.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { x: rect.left, y: rect.top };
}

export function attachProgressScrub(
  root: HTMLElement,
  options: { getVideo: () => HTMLVideoElement | null; onActive?: () => void },
): () => void {
  const bar = root.querySelector('.art-progress');
  const inner = root.querySelector('.art-control-progress-inner');
  if (!(bar instanceof HTMLElement) || !(inner instanceof HTMLElement)) return () => {};

  let dragging = false;
  let touchId = -1;
  let fromTouch = false;
  let axis = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };

  const seekTo = (x: number, y: number) => {
    const video = options.getVideo();
    if (!video) return;
    const duration = scrubDuration(video);
    if (!(duration > 0)) return;
    const ratio = scrubRatio(x, y, axis.start, axis.end);
    const played = bar.querySelector('.art-progress-played');
    const indicator = bar.querySelector('.art-progress-indicator');
    if (played instanceof HTMLElement) played.style.width = `${ratio * 100}%`;
    if (indicator instanceof HTMLElement) indicator.style.left = `${ratio * 100}%`;
    try { video.currentTime = scrubTime(ratio, duration); } catch { /* 媒体还不能跳 */ }
  };

  const touchOf = (list: TouchList): Touch | null => {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].identifier === touchId) return list[i];
    }
    return null;
  };

  const onStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    dragging = true;
    fromTouch = true;
    touchId = event.touches[0].identifier;
    axis = { start: pointAt(inner, 0), end: pointAt(inner, 1) };
    options.onActive?.();
    event.preventDefault();
    event.stopPropagation();
    seekTo(event.touches[0].clientX, event.touches[0].clientY);
  };
  const onMove = (event: TouchEvent) => {
    if (!dragging) return;
    const touch = touchOf(event.touches);
    if (!touch) return;
    event.preventDefault();
    event.stopPropagation();
    seekTo(touch.clientX, touch.clientY);
  };
  const onEnd = (event: TouchEvent) => {
    const touch = touchOf(event.changedTouches);
    if (!touch) return;
    if (dragging) seekTo(touch.clientX, touch.clientY);
    dragging = false;
    touchId = -1;
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event: MouseEvent) => {
    if (!fromTouch) return;
    fromTouch = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const listen = { capture: true, passive: false } as const;
  bar.addEventListener('touchstart', onStart, listen);
  bar.addEventListener('touchmove', onMove, listen);
  bar.addEventListener('touchend', onEnd, listen);
  bar.addEventListener('touchcancel', onEnd, listen);
  bar.addEventListener('click', onClick, true);

  return () => {
    bar.removeEventListener('touchstart', onStart, true);
    bar.removeEventListener('touchmove', onMove, true);
    bar.removeEventListener('touchend', onEnd, true);
    bar.removeEventListener('touchcancel', onEnd, true);
    bar.removeEventListener('click', onClick, true);
  };
}
