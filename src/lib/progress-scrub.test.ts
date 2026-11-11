import { describe, expect, it } from 'vitest';
import { scrubDuration, scrubRatio, scrubTime } from './progress-scrub';

describe('scrubRatio', () => {
  it('横条上按手指位置取比例，并夹在 0 到 1', () => {
    const start = { x: 100, y: 50 };
    const end = { x: 500, y: 50 };
    expect(scrubRatio(100, 50, start, end)).toBe(0);
    expect(scrubRatio(300, 80, start, end)).toBe(0.5);
    expect(scrubRatio(500, 50, start, end)).toBe(1);
    expect(scrubRatio(20, 50, start, end)).toBe(0);
    expect(scrubRatio(900, 50, start, end)).toBe(1);
  });

  it('画面转 90° 后进度条变成竖的，仍按起点到终点投影', () => {
    const start = { x: 40, y: 700 };
    const end = { x: 40, y: 100 };
    expect(scrubRatio(40, 700, start, end)).toBe(0);
    expect(scrubRatio(10, 400, start, end)).toBe(0.5);
    expect(scrubRatio(40, 100, start, end)).toBe(1);
  });
});

describe('scrubTime', () => {
  it('按整段时长换算，不把可拖范围收成几十秒', () => {
    expect(scrubTime(0.25, 3600)).toBeCloseTo(899.9875, 2);
    expect(scrubTime(1, 100)).toBeCloseTo(99.95, 2);
    expect(scrubTime(0.5, 0)).toBe(0);
  });
});

describe('scrubDuration', () => {
  it('优先用有限时长，否则用可跳转区间的终点', () => {
    expect(scrubDuration({ duration: 1200 })).toBe(1200);
    expect(scrubDuration({
      duration: Number.POSITIVE_INFINITY,
      seekable: { length: 1, end: () => 800 },
    })).toBe(800);
    expect(scrubDuration({ duration: Number.NaN, seekable: { length: 0, end: () => 0 } })).toBe(0);
  });
});
