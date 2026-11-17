import { afterEach, describe, expect, it, vi } from 'vitest';
import { prewarmNextEpisode, shouldPrewarmNext, takeWarmedPlaylist } from './video-prefetcher';
import { buildSegmentCacheKey } from './video-cache';

const { put, has } = vi.hoisted(() => ({ put: vi.fn(), has: vi.fn() }));
vi.mock('./video-cache', async importOriginal => ({
  ...await importOriginal<typeof import('./video-cache')>(),
  putCachedSegmentResilient: put,
  hasCachedSegment: has,
  scheduleQuotaCheck: vi.fn(),
}));

const origin = 'https://cdn.example.com/';
const url = origin + 'next.m3u8';

function mockSource() {
  vi.stubGlobal('caches', {});
  vi.stubGlobal('navigator', {});
  has.mockImplementation((key: string) => Promise.resolve(key.endsWith('cached.ts')));
  const playlist = [
    '#EXTM3U',
    '#EXTINF:8,', 'cached.ts',
    '#EXTINF:8,', 'warm.ts',
    '#EXTINF:8,', 'skip.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const request = vi.fn<(input: string, options?: RequestInit) => Promise<Response>>(async input =>
    new Response(input === url ? playlist : new Uint8Array(32)));
  vi.stubGlobal('fetch', request);
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  takeWarmedPlaylist(url);
});

describe('下一集预热', () => {
  it('只取最前两片，复用已有分片和预热后的清单', async () => {
    const request = mockSource();
    const { signal } = new AbortController();
    await prewarmNextEpisode(url, 'next', 720, true, signal);
    expect(request.mock.calls.map(([name]) => name)).toEqual([url, origin + 'warm.ts']);
    expect(request.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(takeWarmedPlaylist(url)?.data).toContain('#EXTM3U');
    expect(takeWarmedPlaylist(url)).toBeUndefined();
  });

  it('清单返回后取消时不发出分片请求', async () => {
    const request = mockSource();
    const controller = new AbortController();
    const promise = prewarmNextEpisode(url, 'next', 0, false, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it('仅在片尾附近、当前缓冲充足时预热', () => {
    vi.stubGlobal('document', { hidden: false });
    const playback = (currentTime: number, bufferedUntil: number, playbackRate = 1) => ({
      paused: false, seeking: false, currentTime, duration: 100, playbackRate,
      buffered: { length: 1, start: () => 0, end: () => bufferedUntil },
    });
    expect(shouldPrewarmNext(playback(35, 100))).toBe(false);
    expect(shouldPrewarmNext(playback(78, 82))).toBe(false);
    expect(shouldPrewarmNext(playback(78, 97))).toBe(true);
    expect(shouldPrewarmNext(playback(78, 97, 2))).toBe(false);
    expect(shouldPrewarmNext(playback(99, 100))).toBe(true);
  });

  it('代理路径与播放器的绝对地址使用同一缓存 key', () => {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch' });
    const relative = '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fseg.ts';
    expect(buildSegmentCacheKey(relative)).toBe(buildSegmentCacheKey('https://app.example.com' + relative));
  });
});
