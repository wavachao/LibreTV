import Hls from 'hls.js';
import { createHlsLoader } from './hls-loader';
import { hasWarmedPlaylist } from './video-prefetcher';
import { PlaybackRecovery, describeHlsError } from './playback-recovery';
import { savePlaybackHealth } from './playback-health';
import { ensurePersistentStorage, loadCacheSettings } from './video-cache';
import type { StreamQuality } from './types';

const STARTUP_LIMIT_MS = 12_000;
const DIRECT_STARTUP_MS = 4_000;
const STALL_LIMIT_MS = 10_000;
const NATIVE_EXTENSIONS = /\.(?:mp4|m4v|webm|mov|ogv)$/i;
const HLS_MIME = 'application/vnd.apple.mpegurl';

export function vodMediaType(url: string): 'file' | 'hls' | 'unknown' {
  try {
    const target = new URL(url, 'https://libretv.invalid');
    const upstream = target.pathname === '/api/proxy' ? target.searchParams.get('url') : null;
    const path = upstream ? new URL(upstream).pathname : target.pathname;
    if (NATIVE_EXTENSIONS.test(path)) return 'file';
    if (/\.m3u8$/i.test(path)) return 'hls';
  } catch { /* 交给播放器尝试解析 */ }
  return 'unknown';
}

export function resumeTime(position: number, duration?: number): number {
  if (!Number.isFinite(position) || position <= 0) return 0;
  return duration && Number.isFinite(duration) && position >= duration - 2 ? 0 : position;
}

interface Options {
  url: string;
  key?: string;
  adFilter: boolean;
  restore: () => number | Promise<number>;
  onFrame: () => void;
  onAutoplayBlocked: () => void;
  onRestored: (position: number) => void;
  onHint: (message: string) => void;
  onError: (message: string, started: boolean, position: number, duration: number) => void;
  onQuality: (quality: StreamQuality) => void;
}

export function createVodPlayback(video: HTMLVideoElement, options: Options): {
  dispose: () => void;
  isHls: () => boolean;
} {
  const type = vodMediaType(options.url);
  const nativeHls = !!video.canPlayType(HLS_MIME);
  const browserHls = Hls.isSupported();
  const initialEngine = type === 'file' || (nativeHls && (!browserHls || !options.adFilter)) ? 'native' : 'hls';
  const url = (() => {
    try { return new URL(options.url, document.baseURI); }
    catch { return undefined; }
  })();
  const proxy = url && /^https?:$/.test(url.protocol) && url.origin !== location.origin
    ? '/api/proxy?url=' + encodeURIComponent(url.href)
    : undefined;
  const saved = Promise.resolve().then(options.restore).then(value => resumeTime(value), () => 0);
  const recovery = new PlaybackRecovery();
  let startedAt = performance.now();
  let firstFrameMs: number | undefined;
  let lastPlayedAt: number | undefined;
  let waitingAt: number | undefined;
  let playedMs = 0;
  let stalledMs = 0;
  let droppedFrames = 0;
  let totalFrames = 0;
  let attempt: AbortController | undefined;
  let destroyAttempt = () => {};
  let directTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let currentEngine = initialEngine;
  let currentUrl = options.url;
  let closed = false;

  const stopPlaying = () => {
    if (lastPlayedAt === undefined) return;
    playedMs += performance.now() - lastPlayedAt;
    lastPlayedAt = undefined;
  };
  const stopWaiting = () => {
    clearTimeout(stallTimer);
    if (waitingAt === undefined) return;
    stalledMs += performance.now() - waitingAt;
    waitingAt = undefined;
  };
  const frameCounts = () => video.getVideoPlaybackQuality?.();

  const report = (failed: boolean) => {
    if (!options.key || (!failed && firstFrameMs === undefined)) return;
    const frames = frameCounts();
    savePlaybackHealth(options.key, {
      firstFrameMs, failed, playedMs, stalledMs,
      droppedFrames: droppedFrames + (frames?.droppedVideoFrames ?? 0),
      totalFrames: totalFrames + (frames?.totalVideoFrames ?? 0),
    });
  };

  const shutdown = (failed = false) => {
    if (closed) return;
    closed = true;
    clearTimeout(startupTimer);
    clearTimeout(directTimer);
    clearTimeout(reconnectTimer);
    recovery.dispose();
    stopPlaying();
    stopWaiting();
    report(failed);
    attempt?.abort();
    destroyAttempt();
  };

  const fail = (message: string) => {
    if (closed) return;
    const position = video.currentTime;
    const duration = video.duration;
    shutdown(true);
    options.onError(message, firstFrameMs !== undefined, position, duration);
  };
  const startupTimer = setTimeout(() => fail('起播超时，可以重试或切换线路'), STARTUP_LIMIT_MS);

  const startAttempt = (mediaUrl: string, engine: 'hls' | 'native', position: Promise<number>, play = true) => {
    if (closed) return;
    if (attempt) {
      const counts = frameCounts();
      droppedFrames += counts?.droppedVideoFrames ?? 0;
      totalFrames += counts?.totalVideoFrames ?? 0;
      attempt.abort();
      destroyAttempt();
    }
    clearTimeout(directTimer);

    currentEngine = engine;
    currentUrl = mediaUrl;
    const controller = new AbortController();
    attempt = controller;
    const { signal } = controller;
    let ready = false;
    let blocked = false;
    let frameSeen = false;
    let target = 0;
    let frameCallback: number | undefined;
    const listen = (name: string, handler: () => void) => video.addEventListener(name, handler, { signal });

    const switchToProxy = () => {
      if (!proxy || mediaUrl === proxy) return false;
      options.onHint('直连响应慢，正在切换到代理');
      const resume = firstFrameMs !== undefined ? Promise.resolve(video.currentTime) : position;
      const continuePlaying = firstFrameMs === undefined || !video.paused;
      if (firstFrameMs !== undefined && continuePlaying) {
        reconnectTimer = setTimeout(() => fail('代理缓冲超时，可以重试或切换线路'), STALL_LIMIT_MS);
      }
      startAttempt(proxy, engine, resume, continuePlaying);
      return true;
    };

    if (firstFrameMs === undefined && proxy && mediaUrl !== proxy) {
      directTimer = setTimeout(() => { if (!signal.aborted) switchToProxy(); }, DIRECT_STARTUP_MS);
    }

    const onFrame = () => {
      if (signal.aborted || frameSeen) return;
      frameSeen = true;
      clearTimeout(startupTimer);
      clearTimeout(directTimer);
      clearTimeout(reconnectTimer);
      recovery.markHealthy();
      if (firstFrameMs === undefined) {
        firstFrameMs = performance.now() - startedAt;
        options.onFrame();
        if (target > 0) options.onRestored(target);
      }
    };

    const watchFrame = () => {
      frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
        if (signal.aborted) return;
        if (ready && !video.seeking && metadata.mediaTime >= target - 0.25) onFrame();
        else watchFrame();
      });
    };
    const canObserveFrame = typeof video.requestVideoFrameCallback === 'function';
    if (canObserveFrame) watchFrame();

    const requestPlay = () => {
      if (!play || signal.aborted) return;
      video.play().catch(error => {
        if (signal.aborted || error.name !== 'NotAllowedError') return;
        blocked = true;
        showPlayButton();
      });
    };
    const showPlayButton = () => {
      if (!blocked || !ready || firstFrameMs !== undefined || video.seeking || video.readyState < 2) return;
      clearTimeout(startupTimer);
      clearTimeout(directTimer);
      options.onAutoplayBlocked();
    };
    const checkReadyFrame = () => {
      if (!ready || video.seeking) return;
      showPlayButton();
      if (!canObserveFrame && video.videoWidth > 0 && video.currentTime >= target - 0.25) onFrame();
    };

    listen('canplay', checkReadyFrame);
    listen('seeked', checkReadyFrame);
    listen('playing', () => {
      if (blocked && firstFrameMs === undefined) startedAt = performance.now();
      blocked = false;
      stopWaiting();
      lastPlayedAt ??= performance.now();
      checkReadyFrame();
    });
    listen('timeupdate', () => {
      if (!video.paused && !video.seeking && waitingAt !== undefined && video.readyState >= 3) {
        stopWaiting();
        lastPlayedAt ??= performance.now();
      }
    });
    listen('waiting', () => {
      stopPlaying();
      if (firstFrameMs === undefined || video.paused || video.seeking || waitingAt !== undefined) return;
      waitingAt = performance.now();
      stallTimer = setTimeout(() => {
        if (!switchToProxy()) fail('缓冲超时，可以重试或切换线路');
      }, STALL_LIMIT_MS);
    });
    for (const event of ['pause', 'seeking', 'ended']) {
      listen(event, () => { stopPlaying(); stopWaiting(); });
    }

    const cancelFrame = () => {
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    };
    destroyAttempt = cancelFrame;

    if (engine === 'native') {
      destroyAttempt = () => {
        cancelFrame();
        video.removeAttribute('src');
        video.load();
      };
      // MP4 可以在没有 CORS 响应头的 CDN 上原生播放，也支持浏览器的 Range 请求。
      video.removeAttribute('crossorigin');
      video.preload = 'auto';
      listen('loadedmetadata', () => {
        void position.then(seconds => {
          if (signal.aborted || ready) return;
          target = resumeTime(seconds, video.duration);
          if (target) video.currentTime = target;
          ready = true;
          checkReadyFrame();
          requestPlay();
        });
      });
      listen('error', () => {
        if (!switchToProxy()) fail('视频无法播放，请尝试其他线路');
      });
      video.src = mediaUrl;
      return;
    }

    if (!browserHls) {
      fail('当前浏览器无法播放此 HLS 线路');
      return;
    }
    const player = new Hls({
      autoStartLoad: false,
      enableWorker: true,
      backBufferLength: 60,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      startLevel: -1,
      testBandwidth: false,
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 3_500,
          maxLoadTimeMs: 5_000,
          timeoutRetry: null,
          errorRetry: null,
        },
      },
      loader: createHlsLoader(Hls, { episodeKey: options.key, blockAd: options.adFilter }),
    });
    destroyAttempt = () => { cancelFrame(); player.destroy(); };
    let manifestParsed = false;
    const samples: { bytes: number; seconds: number }[] = [];
    player.on(Hls.Events.MANIFEST_PARSED, () => {
      manifestParsed = true;
      void position.then(seconds => {
        if (signal.aborted) return;
        const details = player.levels[player.firstLevel]?.details;
        target = resumeTime(seconds, details?.live ? undefined : details?.totalduration);
        const warmedLevel = !target && loadCacheSettings().enabled
          ? player.levels.findIndex(level => hasWarmedPlaylist(level.uri)) : -1;
        if (warmedLevel >= 0) player.startLevel = warmedLevel;
        ready = true;
        player.startLoad(target || -1);
        requestPlay();
      });
    });
    player.on(Hls.Events.LEVEL_UPDATED, (_event, { details }) => {
      if (!frameSeen && target && !details.live && !resumeTime(target, details.totalduration)) {
        target = 0;
        player.startLoad(0);
      }
    });
    player.on(Hls.Events.FRAG_BUFFERED, (_event, { frag }) => {
      if (frameSeen && frag.type === 'main' && frag.sn !== 'initSegment') recovery.markHealthy();
    });
    player.on(Hls.Events.FRAG_LOADED, (_event, { frag, payload }) => {
      if (frag.type !== 'main' || frag.sn === 'initSegment' || !(frag.duration > 0)) return;
      samples.push({ bytes: payload.byteLength, seconds: frag.duration });
      if (samples.length > 12) samples.shift();
      const level = player.levels[frag.level];
      options.onQuality({
        bitrate: samples.reduce((n, s) => n + s.bytes * 8, 0) / samples.reduce((n, s) => n + s.seconds, 0),
        bitrateKind: 'segment',
        frameRate: level?.attrs['FRAME-RATE'] ? Number(level.attrs['FRAME-RATE']) : undefined,
        videoRange: level?.attrs['VIDEO-RANGE'],
      });
    });
    player.on(Hls.Events.BUFFER_CODECS, (_event, data) => {
      if (data.video?.codec) options.onQuality({ codec: data.video.codec });
    });
    player.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || signal.aborted) return;
      const decision = recovery.onFatal(data.type, data.details);
      if ((type === 'unknown' || nativeHls) && decision.action === 'switch-source' &&
          (data.type === Hls.ErrorTypes.MEDIA_ERROR || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR)) {
        startAttempt(mediaUrl, 'native', firstFrameMs === undefined ? position : Promise.resolve(video.currentTime), play);
        return;
      }
      if (decision.action === 'retry') {
        if ((!frameSeen || decision.attempt >= 2) && switchToProxy()) return;
        options.onHint('网络波动，正在重新连接');
        recovery.schedule(decision.delayMs, () => {
          if (signal.aborted) return;
          if (manifestParsed) player.startLoad(frameSeen ? -1 : target || -1);
          else startAttempt(mediaUrl, engine, position, play);
        });
      } else if (decision.action === 'recover-media') {
        if (decision.swapAudio) player.swapAudioCodec();
        player.recoverMediaError();
      } else if (decision.action === 'switch-source') {
        fail(describeHlsError(data.type, data.details));
      }
    });
    listen('error', () => {
      // hls.js 也收到该事件。给它先处理然后检查媒体状态。
      queueMicrotask(() => {
        if (video.error && !signal.aborted && video.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          if (nativeHls || type === 'unknown') startAttempt(mediaUrl, 'native', position, play);
          else fail('当前浏览器无法解码此线路');
        }
      });
    });
    player.attachMedia(video);
    player.loadSource(mediaUrl);
  };

  if (typeof caches !== 'undefined' && options.key && loadCacheSettings().enabled) void ensurePersistentStorage();
  if (url && /^https?:$/.test(url.protocol)) startAttempt(options.url, initialEngine, saved);
  else fail('播放地址无效');

  return {
    dispose: () => shutdown(),
    isHls: () => !closed && currentEngine === 'hls' && currentUrl === options.url,
  };
}
