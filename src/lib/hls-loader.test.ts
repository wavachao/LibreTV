import type Hls from 'hls.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createHlsLoader } from './hls-loader';

const { readSegment, writeSegment } = vi.hoisted(() => ({
  readSegment: vi.fn(), writeSegment: vi.fn(),
}));
vi.mock('./video-cache', async importOriginal => ({
  ...await importOriginal<typeof import('./video-cache')>(),
  readCachedSegment: readSegment,
  putCachedSegmentResilient: writeSegment,
  scheduleQuotaCheck: vi.fn(), touchMeta: vi.fn(),
}));

const network = vi.fn();
class NetworkLoader {
  stats = { loading: { start: 10, end: 30 }, loaded: 0 };
  load = network;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('缓存整片，直接从网络拉取具有真实 Range 的分片', async () => {
  vi.stubGlobal('caches', {});
  const Loader = createHlsLoader({ DefaultConfig: { loader: NetworkLoader } } as unknown as typeof Hls, { episodeKey: 'test' });
  const data = new ArrayBuffer(8);
  const context = { type: 'media-fragment', url: 'https://media.example/seg.ts', rangeStart: 0, rangeEnd: 0, frag: { sn: 3 } };
  const first = vi.fn();
  network.mockImplementationOnce((_ctx, _settings, callbacks) => callbacks.onSuccess({ data }, { loading: { start: 10, end: 30 } }));
  readSegment.mockResolvedValueOnce(null);
  writeSegment.mockResolvedValueOnce('ok');
  await new Loader({}).load(context, {}, { onSuccess: first });
  expect(first).toHaveBeenCalledOnce();
  expect(writeSegment).toHaveBeenCalledWith(context.url, data, expect.objectContaining({ index: 3, costMs: 20 }));

  const replay = vi.fn();
  readSegment.mockResolvedValueOnce({ data, costMs: 20 });
  await new Loader({}).load(context, {}, { onSuccess: replay });
  expect(replay).toHaveBeenCalledWith({ url: context.url, data }, expect.objectContaining({ loaded: 8 }), context, undefined);
  expect(network).toHaveBeenCalledOnce();

  await new Loader({}).load({ ...context, rangeEnd: 8 }, {}, { onSuccess: vi.fn() });
  expect(readSegment).toHaveBeenCalledTimes(2);
  expect(network).toHaveBeenCalledTimes(2);
});
