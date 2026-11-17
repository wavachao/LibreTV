import type HlsType from 'hls.js';
import { stripAdGroups } from './m3u8';
import { takeWarmedPlaylist } from './video-prefetcher';
import {
  buildSegmentCacheKey,
  loadCacheSettings,
  putCachedSegmentResilient,
  readCachedSegment,
  scheduleQuotaCheck,
  touchMeta,
} from './video-cache';

interface LoaderOptions {
  blockAd?: boolean;
  episodeKey?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HlsLoaderCtor = new (config: any) => any;

export function createHlsLoader(
  HlsCtor: typeof HlsType,
  { blockAd = false, episodeKey }: LoaderOptions = {}
): HlsLoaderCtor {
  return class CachedHlsLoader extends (HlsCtor.DefaultConfig.loader as HlsLoaderCtor) {
    private destroyed = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.load = async (context: any, requestConfig: any, callbacks: any) => {
        const settings = episodeKey ? loadCacheSettings() : undefined;
        const cacheEnabled = settings?.enabled && typeof caches !== 'undefined';
        const originalSuccess = callbacks.onSuccess;
        const key = buildSegmentCacheKey(context.url);
        const setStats = (bytes: number, costMs: number) => {
          const end = performance.now();
          const start = end - Math.max(2, costMs);
          Object.assign(this.stats, { loading: { start, first: start + 1, end }, loaded: bytes, total: bytes });
        };

        if (context.type === 'manifest' || context.type === 'level') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
            if (blockAd && typeof response.data === 'string') response.data = stripAdGroups(response.data);
            originalSuccess(response, stats, ctx, networkDetails);
          };
          const warmed = cacheEnabled ? takeWarmedPlaylist(key) : undefined;
          if (warmed) {
            // hls.js 在 load 返回后才完成部分初始化，保留网络回调的异步语义。
            await Promise.resolve();
            if (this.destroyed) return;
            setStats(warmed.data.length, 2);
            callbacks.onSuccess({ url: warmed.url, data: warmed.data }, this.stats, context, undefined);
          } else {
            load(context, requestConfig, callbacks);
          }
          return;
        }

        // hls.js 用 0/0 表示整片。只有有效区间才会发送 Range。
        if (!episodeKey || !settings || !cacheEnabled || context.type !== 'media-fragment' ||
            context.part || context.rangeEnd > context.rangeStart) {
          load(context, requestConfig, callbacks);
          return;
        }

        const cached = await readCachedSegment(key);
        if (this.destroyed) return;
        if (cached) {
          void touchMeta(key);
          // 保留真实下载耗时，避免缓存命中将自适应码率误判成无限带宽。
          setStats(cached.data.byteLength, cached.costMs);
          originalSuccess({ url: context.url, data: cached.data }, this.stats, context, undefined);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
          if (this.destroyed) return;
          if (response.data instanceof ArrayBuffer && response.data.byteLength) {
            const index = typeof context.frag.sn === 'number' ? context.frag.sn : 0;
            const costMs = stats.loading.end - stats.loading.start;
            void putCachedSegmentResilient(key, response.data, { episodeKey, index, costMs, settings })
              .then(() => scheduleQuotaCheck(settings));
          }
          originalSuccess(response, stats, ctx, networkDetails);
        };
        load(context, requestConfig, callbacks);
      };
    }

    abort(): void {
      this.destroyed = true;
      super.abort();
    }

    destroy(): void {
      this.destroyed = true;
      super.destroy?.();
    }
  };
}
