import { parseM3u8Playlist } from './m3u8-parse';
import {
  buildSegmentCacheKey,
  hasCachedSegment,
  loadCacheSettings,
  putCachedSegmentResilient,
  scheduleQuotaCheck,
} from './video-cache';

const PREFETCH_TTL_MS = 45_000;
const warmedPlaylists = new Map<string, { url: string; data: string; timestamp: number }>();

export function hasWarmedPlaylist(url: string): boolean {
  const entry = warmedPlaylists.get(buildSegmentCacheKey(url));
  return !!entry && performance.now() - entry.timestamp < PREFETCH_TTL_MS;
}

export function takeWarmedPlaylist(url: string): { url: string; data: string } | undefined {
  const key = buildSegmentCacheKey(url);
  const entry = warmedPlaylists.get(key);
  warmedPlaylists.delete(key);
  if (entry && performance.now() - entry.timestamp < PREFETCH_TTL_MS) return entry;
}

export function shouldPrewarmNext(video: Pick<HTMLVideoElement, 'paused' | 'seeking' | 'duration' | 'currentTime' | 'playbackRate' | 'buffered'>): boolean {
  if (video.paused || video.seeking || document.hidden) return false;
  const remaining = (video.duration - video.currentTime) / Math.max(1, video.playbackRate);
  if (!(remaining > 0 && remaining <= 30)) return false;
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) > video.currentTime || video.buffered.end(index) < video.currentTime) continue;
    const ahead = (video.buffered.end(index) - video.currentTime) / Math.max(1, video.playbackRate);
    return ahead >= Math.min(15, remaining - 0.5) && ahead >= Math.min(2, remaining);
  }
  return false;
}

export async function prewarmNextEpisode(
  url: string,
  episodeKey: string,
  height: number,
  adFilter: boolean,
  signal: AbortSignal,
): Promise<void> {
  const settings = loadCacheSettings();
  const network = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!settings.enabled || typeof caches === 'undefined' || network?.saveData || /2g|3g/.test(network?.effectiveType ?? '')) return;
  const playlists = new Map<string, { url: string; data: string; timestamp: number }>();
  const parsed = await parseM3u8Playlist(url, 0, height || 1, {
    stripLeadAd: adFilter,
    signal,
    onPlaylist: (key, url, data) => playlists.set(key, { url, data, timestamp: performance.now() }),
  });
  const mediaPlaylist = [...playlists.values()].at(-1);
  if (parsed.byterange || !mediaPlaylist?.data.includes('#EXT-X-ENDLIST')) return;
  for (const [index, segment] of parsed.segments.slice(0, 2).entries()) {
    signal.throwIfAborted();
    const key = buildSegmentCacheKey(segment.url);
    if (await hasCachedSegment(key)) continue;
    signal.throwIfAborted();
    const start = performance.now();
    const response = await fetch(segment.url, { signal, priority: 'low' });
    if (!response.ok || response.status === 206) return;
    const data = await response.arrayBuffer();
    signal.throwIfAborted();
    await putCachedSegmentResilient(key, data, { episodeKey, index, costMs: performance.now() - start, settings });
    scheduleQuotaCheck(settings);
  }
  signal.throwIfAborted();
  warmedPlaylists.clear();
  for (const [key, value] of playlists) warmedPlaylists.set(key, value);
}
