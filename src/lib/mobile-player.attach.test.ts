import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachMobilePlayer } from './mobile-player';

if (typeof globalThis.Element === 'undefined') {
  globalThis.Element = class Element {
    closest(): Element | null {
      return null;
    }
  } as unknown as typeof Element;
}

interface Listener {
  type: string;
  fn: (event: Event) => void;
  capture: boolean;
}

class Node {
  listeners: Listener[] = [];
  classList = {
    add: () => {},
    remove: () => {},
  };
  style: { filter?: string; transform?: string } = {};
  dataset: Record<string, string> = {};
  parent: Node | null = null;

  addEventListener(type: string, fn: (event: Event) => void, opts?: boolean | { capture?: boolean }) {
    const capture = opts === true || (typeof opts === 'object' && !!opts?.capture);
    this.listeners.push({ type, fn, capture });
  }

  removeEventListener(type: string, fn: (event: Event) => void, opts?: boolean | { capture?: boolean }) {
    const capture = opts === true || (typeof opts === 'object' && !!opts?.capture);
    this.listeners = this.listeners.filter((item) => !(item.type === type && item.fn === fn && item.capture === capture));
  }

  closest(selector: string) {
    if (selector === '.mobile-fs-stage') return this.parent;
    return null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON() { return {}; } };
  }

  dispatch(event: Event) {
    for (const item of [...this.listeners]) {
      if (item.type === event.type) item.fn(event);
    }
  }
}

function touch(id: number, x: number, y: number, target: Node) {
  return { identifier: id, clientX: x, clientY: y, target };
}

function fire(node: Node, type: string, x: number, y: number, id = 1) {
  const point = touch(id, x, y, node);
  const event = {
    type,
    target: node,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : [point],
    changedTouches: [point],
    preventDefault() {},
    stopPropagation() {},
  };
  node.dispatch(event as unknown as Event);
}

function videoOf(partial?: { duration?: number; paused?: boolean }) {
  return {
    duration: partial?.duration ?? 1000,
    currentTime: 100,
    volume: 0.8,
    playbackRate: 1,
    paused: partial?.paused ?? false,
    style: {} as { filter?: string },
    dataset: {} as Record<string, string>,
  };
}

describe('attachMobilePlayer', () => {
  beforeAll(() => {
    Object.setPrototypeOf(Node.prototype, Element.prototype);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('按下之前就已经在听 touchmove，不能等 touchstart 再补监听', () => {
    const root = new Node();
    const video = videoOf();
    const stop = attachMobilePlayer(root as unknown as HTMLElement, {
      getVideo: () => video as unknown as HTMLVideoElement,
      allowSeek: true,
      allowRateBoost: true,
      getLocked: () => false,
      onHud: () => {},
    });
    expect(root.listeners.filter((item) => item.type === 'touchmove')).toHaveLength(1);
    expect(root.listeners.filter((item) => item.type === 'touchend')).toHaveLength(1);
    stop();
    expect(root.listeners.filter((item) => item.type === 'touchmove')).toHaveLength(0);
  });

  it('左右滑动会改 currentTime，时长未知也要能拖', () => {
    const root = new Node();
    const video = videoOf({ duration: Number.POSITIVE_INFINITY });
    const stop = attachMobilePlayer(root as unknown as HTMLElement, {
      getVideo: () => video as unknown as HTMLVideoElement,
      allowSeek: true,
      allowRateBoost: true,
      getLocked: () => false,
      onHud: () => {},
    });
    fire(root, 'touchstart', 40, 80);
    fire(root, 'touchmove', 240, 80);
    fire(root, 'touchend', 240, 80);
    // 未知时长按 90 秒窗口，滑过半个画面约 45 秒
    expect(video.currentTime).toBeGreaterThan(140);
    expect(video.playbackRate).toBe(1);
    stop();
  });

  it('手指轻微晃动后长按仍是 3 倍速，松手恢复', () => {
    vi.useFakeTimers();
    const root = new Node();
    const video = videoOf();
    const stop = attachMobilePlayer(root as unknown as HTMLElement, {
      getVideo: () => video as unknown as HTMLVideoElement,
      allowSeek: true,
      allowRateBoost: true,
      getLocked: () => false,
      onHud: () => {},
    });
    fire(root, 'touchstart', 80, 80);
    fire(root, 'touchmove', 90, 86);
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(3);
    expect(video.dataset.boosting).toBe('1');
    fire(root, 'touchend', 90, 86);
    expect(video.playbackRate).toBe(1);
    expect(video.dataset.boosting).toBeUndefined();
    stop();
  });

  it('暂停时不进入 3 倍速', () => {
    vi.useFakeTimers();
    const root = new Node();
    const video = videoOf({ paused: true });
    const stop = attachMobilePlayer(root as unknown as HTMLElement, {
      getVideo: () => video as unknown as HTMLVideoElement,
      allowSeek: true,
      allowRateBoost: true,
      getLocked: () => false,
      onHud: () => {},
    });
    fire(root, 'touchstart', 80, 80);
    vi.advanceTimersByTime(800);
    expect(video.playbackRate).toBe(1);
    stop();
  });
});
