/**
 * 手机全屏横屏。
 *
 * ArtPlayer 的全屏只调用 requestFullscreen。Android 不会因此转动屏幕，
 * 要点全屏按钮之后再 screen.orientation.lock('landscape')。
 * iOS Safari 没有 lock，而且全屏按钮会走进 video.webkitEnterFullscreen，
 * 系统播放器同样不会横过来。触屏改为自己全屏播放器容器：
 * lock 成功就交给系统转屏；失败则在竖屏时把容器转 90°（见 globals.css）。
 */

type OrientationControls = {
  lock?: (type: string) => Promise<void>;
  unlock?: () => void;
};

function orientationControls(screenLike: { orientation?: unknown } | null | undefined): OrientationControls | undefined {
  return screenLike?.orientation as OrientationControls | undefined;
}

export async function lockLandscape(screenLike: { orientation?: unknown } | null | undefined): Promise<boolean> {
  const lock = orientationControls(screenLike)?.lock;
  if (!lock) return false;
  try {
    await lock('landscape');
    return true;
  } catch {
    return false;
  }
}

export function unlockLandscape(screenLike: { orientation?: unknown } | null | undefined) {
  try {
    orientationControls(screenLike)?.unlock?.();
  } catch {
    /* 没锁过，或浏览器不允许解锁 */
  }
}

function fullscreenElement(doc: Document = document): Element | null {
  const anyDoc = doc as Document & {
    webkitFullscreenElement?: Element | null;
  };
  return doc.fullscreenElement ?? anyDoc.webkitFullscreenElement ?? null;
}

const ENTER_ICON = 'inline-flex';

function setFullscreenIcon(root: HTMLElement, active: boolean) {
  const button = root.querySelector('.art-control-fullscreen');
  if (!button) return;
  const icons = button.querySelectorAll('svg');
  if (icons.length >= 2) {
    (icons[0] as SVGElement).style.display = active ? 'none' : ENTER_ICON;
    (icons[1] as SVGElement).style.display = active ? ENTER_ICON : 'none';
  }
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
}

async function requestElementFullscreen(el: HTMLElement): Promise<boolean> {
  if (typeof document === 'undefined' || document.fullscreenEnabled === false) return false;
  const request = el.requestFullscreen?.bind(el);
  if (!request) return false;
  try {
    await request();
  } catch {
    return false;
  }
  if (fullscreenElement() === el) return true;
  if (fullscreenElement()) await document.exitFullscreen?.().catch(() => {});
  return false;
}

export function attachMobileFullscreen(root: HTMLElement): { toggle: () => void; dispose: () => void } {
  let busy = false;
  let disposed = false;

  const clear = () => {
    root.classList.remove('is-mobile-fullscreen', 'pseudo-fullscreen', 'needs-rotate');
    document.documentElement.classList.remove('mobile-fs-lock');
    setFullscreenIcon(root, false);
  };

  const exit = async () => {
    const native = fullscreenElement() === root;
    clear();
    unlockLandscape(typeof screen === 'undefined' ? undefined : screen);
    if (native) await document.exitFullscreen?.().catch(() => {});
  };

  const enter = async () => {
    const native = await requestElementFullscreen(root);
    const locked = native ? await lockLandscape(typeof screen === 'undefined' ? undefined : screen) : false;
    if (disposed) {
      if (native) await document.exitFullscreen?.().catch(() => {});
      unlockLandscape(typeof screen === 'undefined' ? undefined : screen);
      return;
    }
    root.classList.add('is-mobile-fullscreen');
    root.classList.toggle('pseudo-fullscreen', !native);
    root.classList.toggle('needs-rotate', !locked);
    document.documentElement.classList.toggle('mobile-fs-lock', !native);
    setFullscreenIcon(root, true);
  };

  const toggle = () => {
    if (busy) return;
    busy = true;
    void (root.classList.contains('is-mobile-fullscreen') ? exit() : enter()).finally(() => {
      busy = false;
    });
  };

  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest('.art-control');
    if (!control?.classList.contains('art-control-fullscreen')) return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };

  const onFullscreenChange = () => {
    if (!root.classList.contains('is-mobile-fullscreen')) return;
    if (root.classList.contains('pseudo-fullscreen')) return;
    if (fullscreenElement() === root) return;
    unlockLandscape(typeof screen === 'undefined' ? undefined : screen);
    clear();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !root.classList.contains('pseudo-fullscreen')) return;
    event.preventDefault();
    void exit();
  };

  root.addEventListener('click', onClick, true);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('keydown', onKey);

  return {
    toggle,
    dispose() {
      disposed = true;
      root.removeEventListener('click', onClick, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKey);
      void exit();
    },
  };
}

/** 触屏控制栏：点按后停留片刻再收起。不监听 mousemove，避开 issue #937。 */
export function attachTouchControlHide(player: {
  controls: { show: boolean };
  setting?: { show: boolean };
  template: { $player: HTMLElement };
  on: (event: 'control', handler: (show: boolean) => void) => void;
  off: (event: 'control', handler: (show: boolean) => void) => void;
}): () => void {
  const root = player.template.$player;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (player.setting?.show || root.querySelector('.watch-menu-backdrop')) {
        arm();
        return;
      }
      player.controls.show = false;
    }, 3200);
  };
  const onControl = (show: boolean) => {
    if (show) arm();
    else clear();
  };
  const onInteract = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.art-controls, .art-settings, .watch-player-menu')) arm();
  };
  player.on('control', onControl);
  root.addEventListener('touchstart', onInteract, { passive: true });
  root.addEventListener('touchmove', onInteract, { passive: true });
  if (player.controls.show) arm();
  return () => {
    clear();
    player.off('control', onControl);
    root.removeEventListener('touchstart', onInteract);
    root.removeEventListener('touchmove', onInteract);
  };
}
