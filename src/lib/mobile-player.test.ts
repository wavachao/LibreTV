import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_MS,
  brightnessBySwipe,
  brightnessFilter,
  brightnessLevel,
  clampTime,
  formatSignedSeconds,
  mapSwipe,
  matchDoubleTap,
  pickAxis,
  seekBySwipe,
  swipeSeekSpan,
  tapZone,
  volumeBySwipe,
} from './mobile-player';

describe('tapZone', () => {
  it('把画面分成左、中、右三份', () => {
    expect(tapZone(10, 300)).toBe('left');
    expect(tapZone(150, 300)).toBe('center');
    expect(tapZone(290, 300)).toBe('right');
  });

  it('宽度无效时当作中间，避免误快进', () => {
    expect(tapZone(10, 0)).toBe('center');
  });
});

describe('matchDoubleTap', () => {
  const left = { x: 20, y: 40, t: 1000, zone: 'left' as const };

  it('同一侧、时间内、距离近才算双击', () => {
    expect(matchDoubleTap(left, { x: 28, y: 46, t: 1200, zone: 'left' })).toBe(true);
  });

  it('超时、跨侧、落在中间都不算', () => {
    expect(matchDoubleTap(left, { x: 24, y: 40, t: 1000 + DOUBLE_TAP_MS + 1, zone: 'left' })).toBe(false);
    expect(matchDoubleTap(left, { x: 280, y: 40, t: 1100, zone: 'right' })).toBe(false);
    expect(matchDoubleTap(left, { x: 150, y: 40, t: 1100, zone: 'center' })).toBe(false);
    expect(matchDoubleTap(null, left)).toBe(false);
  });
});

describe('滑动', () => {
  it('有时长的点播给出 30 到 180 秒的拖动范围', () => {
    expect(swipeSeekSpan(10_000, true)).toBe(180);
    expect(swipeSeekSpan(100, true)).toBe(30);
    expect(swipeSeekSpan(500, true)).toBe(60);
  });

  it('直播不能拖；点播时长未知时仍给出 90 秒窗口', () => {
    expect(swipeSeekSpan(Number.POSITIVE_INFINITY, true)).toBe(90);
    expect(swipeSeekSpan(0, true)).toBe(90);
    expect(swipeSeekSpan(1200, false)).toBe(0);
  });

  it('水平位移优先拖进度，垂直位移按起点分亮度或音量', () => {
    expect(pickAxis(40, 4, 20, 300, 90)).toBe('seek');
    expect(pickAxis(4, 40, 20, 300, 90)).toBe('brightness');
    expect(pickAxis(4, 40, 220, 300, 90)).toBe('volume');
    expect(pickAxis(40, 4, 20, 300, 0)).toBeNull();
    expect(pickAxis(2, 2, 20, 300, 90)).toBeNull();
  });

  it('进度、音量、亮度都夹在可用范围内', () => {
    expect(seekBySwipe(150, 300, 90)).toBe(45);
    expect(clampTime(10 + 45, 50)).toBe(49.75);
    expect(clampTime(-3, 50)).toBe(0);
    expect(volumeBySwipe(0.4, -100, 200)).toBe(0.9);
    expect(volumeBySwipe(0.2, 400, 200)).toBe(0);
    expect(brightnessBySwipe(1, -200, 200)).toBe(1.8);
    expect(brightnessFilter(1)).toBe('');
    expect(brightnessFilter(1.25)).toBe('brightness(1.250)');
    expect(brightnessLevel(0.3)).toBe(0);
    expect(brightnessLevel(1.8)).toBe(1);
  });
});

describe('mapSwipe', () => {
  it('未旋转时保持屏幕坐标', () => {
    expect(mapSwipe(30, -10, false)).toEqual({ dx: 30, dy: -10 });
  });

  it('顺时针转 90° 后，屏幕上下变成画面左右', () => {
    expect(mapSwipe(4, 40, true)).toEqual({ dx: 40, dy: -4 });
  });
});

describe('formatSignedSeconds', () => {
  it('不足一分钟用秒，超过用分秒', () => {
    expect(formatSignedSeconds(8.2)).toBe('+8s');
    expect(formatSignedSeconds(-75)).toBe('−1:15');
  });
});
