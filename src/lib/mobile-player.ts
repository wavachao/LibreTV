/**
 * 手机播放手势。判定放在纯函数里，挂到播放器上的只是事件转发。
 *
 * 左侧上下滑调亮度（画面滤镜，网页改不了系统亮度），右侧上下滑调音量，
 * 水平滑进度，双击左右三分之一快退/快进，长按临时 3 倍速。
 * 直播没有可拖的进度，调用方把 allowSeek 关掉即可。
 */

/** 小于这个位移只当手指抖动，不取消长按，也不开始滑动。 */
export const MOVE_SLOP = 28;
export const DOUBLE_TAP_MS = 280;
export const DOUBLE_TAP_SLOP = 36;
export const LONG_PRESS_MS = 500;
export const DOUBLE_TAP_SEC = 10;
export const BOOST_RATE = 3;

export type TapZone = 'left' | 'center' | 'right';
export type SwipeAxis = 'seek' | 'brightness' | 'volume';

export interface TapPoint {
  x: number;
  y: number;
  t: number;
  zone: TapZone;
}

export interface GestureHud {
  text: string;
  /** 0–1，音量/亮度条。没有则不画条。 */
  level?: number;
}

export function tapZone(x: number, width: number): TapZone {
  if (!(width > 0)) return 'center';
  const ratio = x / width;
  if (ratio < 1 / 3) return 'left';
  if (ratio > 2 / 3) return 'right';
  return 'center';
}

export function matchDoubleTap(prev: TapPoint | null, next: TapPoint): boolean {
  if (!prev || prev.zone === 'center' || next.zone === 'center') return false;
  if (prev.zone !== next.zone) return false;
  if (next.t < prev.t || next.t - prev.t > DOUBLE_TAP_MS) return false;
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  return dx * dx + dy * dy <= DOUBLE_TAP_SLOP * DOUBLE_TAP_SLOP;
}

/**
 * 水平滑过整幅画面时的秒数。
 * 直播（allowSeek 为 false）不能拖。点播时长还没出来、或清单没给总时长时，
 * 仍按 90 秒的窗口拖，否则手势会完全没反应。
 */
export function swipeSeekSpan(duration: number, allowSeek: boolean): number {
  if (!allowSeek) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 90;
  return Math.min(180, Math.max(30, duration * 0.12));
}

/** 全屏把画面顺时针转了 90° 时，屏幕上的上下才是画面里的左右。 */
export function mapSwipe(dx: number, dy: number, rotated: boolean): { dx: number; dy: number } {
  if (!rotated) return { dx, dy };
  return { dx: dy, dy: -dx };
}

export function pickAxis(
  dx: number,
  dy: number,
  startX: number,
  width: number,
  seekSpan: number,
): SwipeAxis | null {
  if (dx * dx + dy * dy < MOVE_SLOP * MOVE_SLOP) return null;
  if (Math.abs(dx) > Math.abs(dy)) return seekSpan > 0 ? 'seek' : null;
  return startX < width / 2 ? 'brightness' : 'volume';
}

export function seekBySwipe(dx: number, width: number, span: number): number {
  if (!(width > 0) || !(span > 0)) return 0;
  return (dx / width) * span;
}

export function clampTime(time: number, duration: number): number {
  const max = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.25) : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, time), max);
}

export function volumeBySwipe(start: number, dy: number, height: number): number {
  const delta = height > 0 ? -dy / height : 0;
  return clamp(start + delta, 0, 1);
}

/** 亮度用 video 的 CSS filter，1 为原始画面，手感按「滑满一整屏约 ±1.2」来。 */
export function brightnessBySwipe(start: number, dy: number, height: number): number {
  const delta = height > 0 ? (-dy / height) * 1.2 : 0;
  return clamp(start + delta, 0.3, 1.8);
}

export function brightnessFilter(value: number): string {
  if (Math.abs(value - 1) < 0.02) return '';
  return `brightness(${value.toFixed(3)})`;
}

export function brightnessLevel(value: number): number {
  return clamp((value - 0.3) / 1.5, 0, 1);
}

export function formatSignedSeconds(delta: number): string {
  const sign = delta >= 0 ? '+' : '−';
  const abs = Math.abs(Math.round(delta));
  const minutes = Math.floor(abs / 60);
  const seconds = abs % 60;
  if (minutes > 0) return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${sign}${seconds}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const IGNORE = '.art-controls, .art-settings, .art-progress, .watch-player-menu, .watch-menu-backdrop, .watch-mobile-lock, .watch-gesture-coach, button, a, input, textarea, select';

export interface MobilePlayerOptions {
  getVideo: () => HTMLVideoElement | null;
  allowSeek: boolean;
  allowRateBoost: boolean;
  getLocked: () => boolean;
  onHud: (hud: GestureHud | null) => void;
}

export function attachMobilePlayer(root: HTMLElement, options: MobilePlayerOptions): () => void {
  root.classList.add('has-mobile-gestures');
  let brightness = 1;
  let active: {
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
    axis: SwipeAxis | null;
    moved: boolean;
    long: boolean;
    startVolume: number;
    startBrightness: number;
    startTime: number;
    duration: number;
    span: number;
    originalRate: number;
  } | null = null;
  let lastTap: TapPoint | null = null;
  let swallowUntil = 0;
  let longTimer: ReturnType<typeof setTimeout> | null = null;
  let hudTimer: ReturnType<typeof setTimeout> | null = null;

  const armSwallow = () => { swallowUntil = performance.now() + 450; };
  const clearLong = () => {
    if (longTimer) clearTimeout(longTimer);
    longTimer = null;
  };
  const showHud = (hud: GestureHud) => {
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = null;
    options.onHud(hud);
  };
  const clearHudSoon = () => {
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => options.onHud(null), 650);
  };

  // 触摸监听必须在按下之前就挂上。iOS 不会把本次手势的后续事件
  // 交给 touchstart 里才加上的 document 监听，所以滑动和松手都会丢。
  let touchId = -1;
  let fromTouch = false;
  let boostTimer: ReturnType<typeof setInterval> | null = null;
  const stopBoost = () => {
    if (boostTimer) clearInterval(boostTimer);
    boostTimer = null;
    const media = options.getVideo();
    if (media) delete media.dataset.boosting;
  };
  const holdBoost = (media: HTMLVideoElement) => {
    media.dataset.boosting = '1';
    const apply = () => {
      if (media.playbackRate !== BOOST_RATE) media.playbackRate = BOOST_RATE;
    };
    apply();
    // 分片加载会把倍速弹回 1，按住期间补回去。
    if (boostTimer) clearInterval(boostTimer);
    boostTimer = setInterval(apply, 200);
  };

  const refreshSpan = (video: HTMLVideoElement) => {
    if (!active || !options.allowSeek) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    active.duration = duration;
    active.span = swipeSeekSpan(duration, true);
  };

  const trackedTouch = (list: TouchList): Touch | null => {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].identifier === touchId) return list[i];
    }
    return null;
  };

  const rotated = () => {
    const stage = root.closest?.('.mobile-fs-stage') as HTMLElement | null;
    return !!stage && /rotate\(90deg\)/.test(stage.style.transform || '');
  };

  const finishAt = (x: number, y: number) => {
    const current = active;
    active = null;
    touchId = -1;
    clearLong();
    const video = options.getVideo();
    if (current?.long && video) {
      stopBoost();
      video.playbackRate = current.originalRate || 1;
      armSwallow();
      clearHudSoon();
      return;
    }
    stopBoost();
    if (current?.moved && current.axis === 'seek' && video) {
      const delta = seekBySwipe(x - current.startX, current.width, current.span);
      try { video.currentTime = clampTime(current.startTime + delta, video.duration || current.duration); } catch { /* 忽略 */ }
      armSwallow();
      clearHudSoon();
      return;
    }
    if (current?.moved) {
      armSwallow();
      clearHudSoon();
      return;
    }
    if (!current || !options.allowSeek || !video) return;
    const rect = root.getBoundingClientRect();
    const tap: TapPoint = {
      x,
      y,
      t: performance.now(),
      zone: tapZone(x - rect.left, rect.width),
    };
    if (matchDoubleTap(lastTap, tap)) {
      const delta = tap.zone === 'left' ? -DOUBLE_TAP_SEC : DOUBLE_TAP_SEC;
      try { video.currentTime = clampTime(video.currentTime + delta, video.duration); } catch { /* 忽略 */ }
      showHud({ text: delta < 0 ? `快退 ${DOUBLE_TAP_SEC} 秒` : `快进 ${DOUBLE_TAP_SEC} 秒` });
      clearHudSoon();
      armSwallow();
      lastTap = null;
      return;
    }
    lastTap = tap.zone === 'center' ? null : tap;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.watch-mobile-lock')) return;
    if (options.getLocked()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (target?.closest(IGNORE)) return;
    if (active) return;
    const video = options.getVideo();
    if (!video) return;
    const touch = event.touches[0];
    const rect = root.getBoundingClientRect();
    fromTouch = true;
    touchId = touch.identifier;
    active = {
      pointerId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      width: rect.width,
      height: rect.height,
      axis: null,
      moved: false,
      long: false,
      startVolume: video.volume,
      startBrightness: brightness,
      startTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: video.duration,
      span: swipeSeekSpan(video.duration, options.allowSeek),
      originalRate: video.playbackRate || 1,
    };
    clearLong();
    longTimer = setTimeout(() => {
      longTimer = null;
      const current = active;
      const media = options.getVideo();
      if (!current || current.moved || !media || media.paused || !options.allowRateBoost) return;
      current.long = true;
      current.originalRate = media.playbackRate || 1;
      holdBoost(media);
      showHud({ text: '3 倍速' });
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent) => {
    const current = active;
    const touch = trackedTouch(event.touches);
    if (!current || !touch) return;
    const mapped = mapSwipe(touch.clientX - current.startX, touch.clientY - current.startY, rotated());
    const dx = mapped.dx;
    const dy = mapped.dy;
    const video = options.getVideo();
    if (current.long) {
      event.preventDefault();
      return;
    }
    if (video) refreshSpan(video);
    if (!current.axis) {
      const axis = pickAxis(dx, dy, current.startX - root.getBoundingClientRect().left, current.width, current.span);
      const pastSlop = dx * dx + dy * dy >= MOVE_SLOP * MOVE_SLOP;
      if (!axis) {
        if (pastSlop) current.moved = true;
        return;
      }
      current.axis = axis;
      current.moved = true;
      clearLong();
    }
    event.preventDefault();
    if (!video) return;
    if (current.axis === 'seek') {
      const delta = seekBySwipe(dx, current.width, current.span);
      const at = clampTime(current.startTime + delta, video.duration || current.duration);
      try { video.currentTime = at; } catch { /* 拖动中偶发未就绪 */ }
      showHud({ text: `${formatClock(at)}  ${formatSignedSeconds(delta)}` });
      return;
    }
    if (current.axis === 'volume') {
      const value = volumeBySwipe(current.startVolume, dy, current.height);
      video.volume = value;
      showHud({ text: `音量 ${Math.round(value * 100)}%`, level: value });
      return;
    }
    brightness = brightnessBySwipe(current.startBrightness, dy, current.height);
    video.style.filter = brightnessFilter(brightness);
    showHud({ text: `亮度 ${Math.round(brightnessLevel(brightness) * 100)}%`, level: brightnessLevel(brightness) });
  };

  const onTouchEnd = (event: TouchEvent) => {
    const touch = trackedTouch(event.changedTouches);
    if (!touch) return;
    finishAt(touch.clientX, touch.clientY);
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.watch-mobile-lock')) return;
    if (options.getLocked() || performance.now() < swallowUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onContextMenu = (event: Event) => {
    if (fromTouch) event.preventDefault();
  };

  const listen = { capture: true, passive: false } as const;
  root.addEventListener('touchstart', onTouchStart, listen);
  root.addEventListener('touchmove', onTouchMove, listen);
  root.addEventListener('touchend', onTouchEnd, listen);
  root.addEventListener('touchcancel', onTouchEnd, listen);
  root.addEventListener('click', onClick, true);
  root.addEventListener('contextmenu', onContextMenu);

  return () => {
    clearLong();
    stopBoost();
    if (hudTimer) clearTimeout(hudTimer);
    const video = options.getVideo();
    if (active?.long && video) video.playbackRate = active.originalRate || 1;
    active = null;
    root.classList.remove('has-mobile-gestures');
    root.removeEventListener('touchstart', onTouchStart, true);
    root.removeEventListener('touchmove', onTouchMove, true);
    root.removeEventListener('touchend', onTouchEnd, true);
    root.removeEventListener('touchcancel', onTouchEnd, true);
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('contextmenu', onContextMenu);
    options.onHud(null);
  };
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
