import { describe, expect, it, vi } from 'vitest';
import { effectiveLandscapeLock, fullscreenLossAction, lockLandscape, stageBox, unlockLandscape } from './mobile-fullscreen';

describe('lockLandscape', () => {
  it('锁定 landscape，左右两个横屏方向都允许', async () => {
    const orientation = { lock: vi.fn(async () => {}) };
    await expect(lockLandscape({ orientation })).resolves.toBe(true);
    expect(orientation.lock).toHaveBeenCalledWith('landscape');
  });

  it('浏览器拒绝锁定时返回 false，调用方改走 CSS 旋转', async () => {
    const orientation = { lock: vi.fn(async () => { throw new Error('not supported'); }) };
    await expect(lockLandscape({ orientation })).resolves.toBe(false);
  });

  it('没有 orientation.lock（旧浏览器 / iOS）返回 false', async () => {
    await expect(lockLandscape(undefined)).resolves.toBe(false);
    await expect(lockLandscape({ orientation: {} })).resolves.toBe(false);
  });
});

describe('stageBox', () => {
  it('竖屏全屏时，内层转 90° 后盖住 390×844', () => {
    expect(stageBox(390, 844, false)).toEqual({
      left: 390,
      top: 0,
      width: 844,
      height: 390,
      transform: 'rotate(90deg)',
    });
  });

  it('系统已经转成横屏时，内层只铺满，不再旋转', () => {
    expect(stageBox(844, 390, true)).toEqual({
      left: 0,
      top: 0,
      width: 844,
      height: 390,
      transform: 'none',
    });
  });
});

describe('effectiveLandscapeLock', () => {
  it('视口已经横屏时，方向锁仍然有效，不再 CSS 旋转', () => {
    expect(effectiveLandscapeLock(844, 390, true)).toBe(true);
  });

  it('锁屏把方向锁解开、屏幕回到竖屏时，不能再相信旧的锁定标记', () => {
    expect(effectiveLandscapeLock(390, 844, true)).toBe(false);
    expect(stageBox(390, 844, effectiveLandscapeLock(390, 844, true)).transform).toBe('rotate(90deg)');
  });
});

describe('fullscreenLossAction', () => {
  it('页面被锁屏藏起来时保留全屏，回到前台再锁横屏', () => {
    expect(fullscreenLossAction('hidden')).toBe('keep');
  });

  it('页面还看得见时退出全屏，才是用户要离开', () => {
    expect(fullscreenLossAction('visible')).toBe('exit');
  });
});

describe('unlockLandscape', () => {
  it('退出全屏时解锁', () => {
    const orientation = { unlock: vi.fn() };
    unlockLandscape({ orientation });
    expect(orientation.unlock).toHaveBeenCalledOnce();
  });

  it('解锁抛错也不影响退出全屏', () => {
    const orientation = {
      unlock: () => { throw new Error('not locked'); },
    };
    expect(() => unlockLandscape({ orientation })).not.toThrow();
    expect(() => unlockLandscape(undefined)).not.toThrow();
  });
});
