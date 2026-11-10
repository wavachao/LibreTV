/**
 * 手机全屏横屏。
 *
 * 腾讯视频、爱奇艺点全屏，是系统界面消失，并且画面变成横屏。
 * 只旋转播放器、退出系统全屏，浏览器边栏还在，看起来就不是全屏。
 * 系统全屏元素本身不能旋转（浏览器会丢掉 transform），所以：
 * 外层进入系统全屏，内层在仍然是竖屏时转 90°。
 * Android 能锁定方向时，交给系统把屏幕转成横屏，内层不再转。
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

/** 外层已经是横屏时铺满；外层仍是竖屏时，内层转 90° 后正好盖住外层。 */
export function stageBox(width: number, height: number, landscapeAlready: boolean): {
  left: number;
  top: number;
  width: number;
  height: number;
  transform: string;
} {
  if (landscapeAlready || width >= height) {
    return { left: 0, top: 0, width, height, transform: 'none' };
  }
  return { left: width, top: 0, width: height, height: width, transform: 'rotate(90deg)' };
}

function fullscreenElement(doc: Document = document): Element | null {
  const anyDoc = doc as Document & { webkitFullscreenElement?: Element | null };
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

function viewportBox(): { left: number; top: number; width: number; height: number } {
  const view = window.visualViewport;
  return {
    left: Math.round(view?.offsetLeft ?? 0),
    top: Math.round(view?.offsetTop ?? 0),
    width: Math.round(view?.width ?? window.innerWidth),
    height: Math.round(view?.height ?? window.innerHeight),
  };
}

async function requestFullscreen(el: HTMLElement): Promise<boolean> {
  const request = el.requestFullscreen?.bind(el);
  if (!request || document.fullscreenEnabled === false) return false;
  try {
    await request();
  } catch {
    return false;
  }
  return fullscreenElement() === el;
}

async function exitFullscreen() {
  if (fullscreenElement()) await document.exitFullscreen?.().catch(() => {});
}

export function attachMobileFullscreen(root: HTMLElement): { toggle: () => void; dispose: () => void } {
  let busy = false;
  let disposed = false;
  let active = false;
  let shell: HTMLElement | null = null;
  let stage: HTMLElement | null = null;
  let placeholder: Comment | null = null;
  let landscapeLocked = false;

  const layout = () => {
    if (!shell || !stage) return;
    const box = viewportBox();
    const fullscreen = fullscreenElement() === shell;
    if (!fullscreen) {
      shell.style.left = `${box.left}px`;
      shell.style.top = `${box.top}px`;
      shell.style.width = `${box.width}px`;
      shell.style.height = `${box.height}px`;
    }
    const width = fullscreen ? shell.clientWidth || box.width : box.width;
    const height = fullscreen ? shell.clientHeight || box.height : box.height;
    const frame = stageBox(width, height, landscapeLocked);
    stage.style.left = `${frame.left}px`;
    stage.style.top = `${frame.top}px`;
    stage.style.width = `${frame.width}px`;
    stage.style.height = `${frame.height}px`;
    stage.style.transform = frame.transform;
  };

  const onViewport = () => {
    if (active) layout();
  };

  const openLayers = () => {
    shell = document.createElement('div');
    stage = document.createElement('div');
    shell.className = 'mobile-fs-shell';
    stage.className = 'mobile-fs-stage';
    shell.style.cssText = 'position:fixed;z-index:2147483646;margin:0;background:#000;overflow:hidden;';
    stage.style.cssText = 'position:absolute;margin:0;background:#000;transform-origin:top left;';
    shell.appendChild(stage);
    placeholder = document.createComment('mobile-fs');
    root.parentElement?.insertBefore(placeholder, root);
    stage.appendChild(root);
    document.body.appendChild(shell);
    root.style.setProperty('position', 'absolute', 'important');
    root.style.setProperty('inset', '0', 'important');
    root.style.setProperty('width', '100%', 'important');
    root.style.setProperty('height', '100%', 'important');
    root.style.setProperty('max-width', 'none', 'important');
    root.style.setProperty('max-height', 'none', 'important');
  };

  const closeLayers = () => {
    root.style.removeProperty('position');
    root.style.removeProperty('inset');
    root.style.removeProperty('width');
    root.style.removeProperty('height');
    root.style.removeProperty('max-width');
    root.style.removeProperty('max-height');
    if (placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(root, placeholder);
      placeholder.remove();
    }
    placeholder = null;
    shell?.remove();
    shell = null;
    stage = null;
  };

  const clear = () => {
    active = false;
    landscapeLocked = false;
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('scroll', onViewport);
    window.removeEventListener('resize', onViewport);
    document.documentElement.classList.remove('mobile-fs-lock');
    root.classList.remove('is-mobile-fullscreen');
    closeLayers();
    setFullscreenIcon(root, false);
  };

  const exit = async () => {
    clear();
    unlockLandscape(typeof screen === 'undefined' ? undefined : screen);
    await exitFullscreen();
  };

  const enter = async () => {
    openLayers();
    document.documentElement.classList.add('mobile-fs-lock');
    const native = shell ? await requestFullscreen(shell) : false;
    landscapeLocked = native ? await lockLandscape(typeof screen === 'undefined' ? undefined : screen) : false;
    if (landscapeLocked) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const box = viewportBox();
      if (box.height > box.width) {
        unlockLandscape(typeof screen === 'undefined' ? undefined : screen);
        landscapeLocked = false;
      }
    }
    if (disposed) {
      clear();
      unlockLandscape(typeof screen === 'undefined' ? undefined : screen);
      await exitFullscreen();
      return;
    }
    active = true;
    root.classList.add('is-mobile-fullscreen');
    setFullscreenIcon(root, true);
    layout();
    window.visualViewport?.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('scroll', onViewport);
    window.addEventListener('resize', onViewport);
  };

  const toggle = () => {
    if (busy) return;
    busy = true;
    void (active ? exit() : enter()).finally(() => {
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
    if (!active || !shell) return;
    if (fullscreenElement() === shell) return;
    void exit();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !active) return;
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
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clearTimer();
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
    else clearTimer();
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
    clearTimer();
    player.off('control', onControl);
    root.removeEventListener('touchstart', onInteract);
    root.removeEventListener('touchmove', onInteract);
  };
}
