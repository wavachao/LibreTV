export interface PlaybackHealth {
  firstFrameMs?: number;
  playedMs: number;
  stalledMs: number;
  droppedFrames: number;
  totalFrames: number;
  failed: boolean;
}

const STORAGE_KEY = 'libretv-playback-health';
const MAX_ENTRIES = 60;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
type Entry = PlaybackHealth & { timestamp: number };

export function playbackKey(source: string, id: string, line: number, episode: number): string {
  return JSON.stringify([source, id, line, episode]);
}

function readEntries(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
}

export function readPlaybackHealth(key: string): PlaybackHealth | undefined {
  const entry = readEntries()[key];
  return entry && Date.now() - entry.timestamp < MAX_AGE_MS ? entry : undefined;
}

export function savePlaybackHealth(key: string, health: PlaybackHealth): void {
  try {
    const entries = readEntries();
    const timestamp = Date.now();
    delete entries[key];
    const recent = Object.entries(entries)
      .filter(([, entry]) => timestamp - entry.timestamp < MAX_AGE_MS)
      .slice(-(MAX_ENTRIES - 1));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...recent, [key, { ...health, timestamp }]])));
  } catch { /* 播放仍可在禁用存储时使用 */ }
}

export function playbackScore(health?: PlaybackHealth): number {
  if (!health) return Infinity;
  if (health.failed) return Infinity;
  return (health.firstFrameMs ?? 3000) + 60_000 * health.stalledMs / Math.max(10_000, health.playedMs);
}
