// Fork modification by wavachao (2026-11-03): accessible speed and episode menus inside the player.
'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import { Icon } from './icon';
import { useFocusTrap } from './use-focus-trap';
import type { StreamQuality } from '@/lib/types';

import { createVodPlayback, vodMediaType } from '@/lib/vod-playback';
import { prewarmNextEpisode, shouldPrewarmNext } from '@/lib/video-prefetcher';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import { CONTROL_SHOW_CLASS, syncMiniProgressBar } from '@/lib/mini-progress-bar';
import { cn, formatTime } from '@/lib/utils';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { attachMobileFullscreen, attachTouchControlHide } from '@/lib/mobile-fullscreen';
import { attachMobilePlayer, type GestureHud } from '@/lib/mobile-player';
import { attachProgressScrub } from '@/lib/progress-scrub';
import { GestureChrome } from './gesture-chrome';
import {
  findActiveSegment,
  findCrossedEnding,
  resolveSegments,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type ResolvedSegment,
  type SkipMark,
  type SkipSegment,
} from '@/lib/skip-marks';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from '@/lib/control-hide';

/** 片段时间统一保留 1 位小数：与面板展示保持一致，避免浮点尾巴 */
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、手机手势播放、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只切换媒体源
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

/** 暴露给播放页的读取接口：「记录当前」需要比 5s 节流进度回调更精确的位置 */
export interface PlayerSkipApi {
  getCurrentTime(): number;
  getDuration(): number;
  getFullscreenHost(): HTMLElement | null;
  /** 跳转到指定位置（「试跳」/标记片段起点用） */
  seek(seconds: number): void;
  /** 暂停播放：记录标记前先定格，避免点击到读取之间视频继续走 */
  pause(): void;
  /** 当前是否处于暂停状态 */
  isPaused(): boolean;
}

interface PlayerShellProps {
  url: string;
  title: string;
  sourceName?: string;
  episodeCount?: number;
  currentEpisode?: number;
  onSelectEpisode?: (index: number) => void;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的跳过片段标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /**
   * 自动跳过标记的片段：片头/中段跳到片段末尾，片尾（连续播放越过起点）结束本集。
   * 是否连播下一集仍由 autoplayNext 决定。
   */
  autoSkipSegments: boolean;
  /**
   * 音量放大（Web Audio 增益链）：默认 false。
   * 关闭时完全不接入音频链路；播放中改开关由 setBoost 走「直通/增益」切换。
   */
  volumeBoost: boolean;
  /**
   * 底部细进度条（默认 true）：控制栏收起后是否在画面底边常驻一条 3px 进度线。
   * 关闭后收起即完全隐藏。类名同步见 lib/mini-progress-bar.ts。
   */
  miniProgressBar?: boolean;
  /** 中段两步态的起点：由页面层持有，面板与快捷键共用同一份状态 */
  pendingStart: number | null;
  /** 更新中段起点；null 表示取消或已消费 */
  onPendingStart: (start: number | null) => void;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
  /** 快捷键（Shift+I/O/S/E）记录片段时回调，由父级做校验与写入 */
  onRecordSegment?: (segment: SkipSegment) => void;
  /** 剧集与线路标识，用于分片缓存和本地播放记录 */
  episodeKey?: string;
  /** 当前播放有余量时预热下一集的开头 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   */
  onQuality?: (quality: StreamQuality) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 控制条上的上一集 / 下一集：不在播放器里也能切集，省得回到页面按钮 */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
}

export function PlayerShell({
  url,
  title,
  sourceName,
  episodeCount = 0,
  currentEpisode = 0,
  onSelectEpisode,
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipSegments,
  volumeBoost,
  miniProgressBar = true,
  pendingStart,
  onPendingStart,
  onPlayerApi,
  onRecordSegment,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const playerSession = useRef<ReturnType<typeof createVodPlayback> | null>(null);
  const warmup = useRef<AbortController | null>(null);
  const failedPosition = useRef<number | null>(null);
  const playbackCallbacks = useRef({ onPause, onTimeUpdate, onEnded });
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<'speed' | 'episodes' | 'tools' | null>(null);
  const [touchUi, setTouchUi] = useState(false);
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const [gestureHud, setGestureHud] = useState<GestureHud | null>(null);
  const hudSetter = useRef<(hud: GestureHud | null) => void>(() => {});
  hudSetter.current = setGestureHud;
  const [aspect, setAspect] = useState<'default' | 'cover' | '16:9' | '4:3'>('default');
  const [sleepMin, setSleepMin] = useState<number | null>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [abLoop, setAbLoop] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const abRef = useRef(abLoop);
  abRef.current = abLoop;
  useEffect(() => { setTouchUi(prefersTouchPointer()); }, []);
  const [playbackRate, setPlaybackRate] = useState(1);
  const menuRef = useRef<HTMLDivElement>(null);
  useFocusTrap(menu !== null, menuRef);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [menu]);
  // 目标视频帧出现后移除起播遮罩。
  const [showPoster, setShowPoster] = useState(true);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const streamInfoRef = useRef<StreamQuality>({});
  const reportQuality = (quality: StreamQuality) => {
    streamInfoRef.current = { ...streamInfoRef.current, ...quality };
    propsRef.current.onQuality?.(streamInfoRef.current);
  };

  const playbackStartedRef = useRef(false);
  const restoredRef = useRef(false);

  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 跳过片段：每集已处理的片段（按 type:start 去重），换集时重置（见 loadEpisode）
  const handledSegmentsRef = useRef<Set<string>>(new Set());
  // 被「撤销」过的片段：本集不再自动跳（否则撤回到片段内会被立刻再跳走），但仍保留提示按钮
  const suppressedAutoRef = useRef<Set<string>>(new Set());
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<ResolvedSegment | null>(null);
  const skipPromptRef = useRef<ResolvedSegment | null>(null);
  // 刚跳过的片段：给一个撤销窗口，误标导致跳掉正片时不必手动拖回去
  const [undoSkip, setUndoSkip] = useState<{ from: number; segment: ResolvedSegment } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  const requestSwitchSource = (reason: string) => {
    propsRef.current.onRequestSwitchSource?.(reason);
  };

  const cancelWarmup = () => {
    warmup.current?.abort();
    warmup.current = null;
  };

  const maybeWarmNext = (video: HTMLVideoElement) => {
    const { nextUrl, nextEpisodeKey, adFilter } = propsRef.current;
    if (!nextUrl || !nextEpisodeKey || vodMediaType(nextUrl) === 'file' || warmup.current ||
        !playbackStartedRef.current || !playerSession.current?.isHls() || !shouldPrewarmNext(video)) return;
    const controller = new AbortController();
    warmup.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    void prewarmNextEpisode(nextUrl, nextEpisodeKey, video.videoHeight, adFilter, signal).catch(() => {});
  };

  /** 切换提示状态；值相同直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: ResolvedSegment | null) => {
    const prev = skipPromptRef.current;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.end === next.end);
    if (same) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 片段去重键：按类型 + 起点，同一集内每段只处理一次 */
  const segmentKey = (s: ResolvedSegment) => `${s.type}:${s.start}`;

  /** 进度条区间可视化：在进度条轨道叠加半透明色带（颜色与面板图例共用 SEGMENT_COLORS） */
  const renderSkipMarks = () => {
    const art = artRef.current;
    const progress = art?.template.$progress;
    if (!progress) return;
    progress.querySelectorAll('[data-skip-segment]').forEach((el: Element) => el.remove());
    const duration = art.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const segments = resolveSegments(propsRef.current.skipMark, duration);
    for (const seg of segments) {
      const el = document.createElement('div');
      el.dataset.skipSegment = '1';
      el.title = `跳过${SEGMENT_LABELS[seg.type]}`;
      const left = (seg.start / duration) * 100;
      const width = Math.max(0.4, ((seg.end - seg.start) / duration) * 100);
      el.style.cssText = `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${SEGMENT_COLORS[seg.type]};pointer-events:none;`;
      progress.appendChild(el);
    }
  };

  /**
   * 跳到片段末尾并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」。
   * 返回是否成功：媒体未就绪导致赋值失败时返回 false，调用方不置已处理标记，
   * 下一次 timeupdate 会重新判定（保证「可重试」）。
   */
  const skipTo = (seconds: number): boolean => {
    const art = artRef.current;
    if (!art || !Number.isFinite(seconds) || seconds < 0) return false;
    try {
      art.currentTime = seconds;
    } catch {
      return false;
    }
    lastSampleRef.current = seconds;
    cancelWarmup();
    return true;
  };

  /** 记录一次跳过（跳转前的位置）：给 12s 撤销窗口，误标导致跳掉正片时不用手动拖回去 */
  const rememberSkip = (from: number, segment: ResolvedSegment) => {
    setUndoSkip({ from, segment });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSkip(null), 12_000);
  };

  const undoLastSkip = () => {
    const last = undoSkip;
    if (!last) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    // 撤销后把片段从「已处理」移除（按钮会重新出现），同时本集不再自动跳它：
    // 否则回到片段内会被下一次 timeupdate 立刻再跳走，形成"撤销→又被跳过"的死循环
    handledSegmentsRef.current.delete(segmentKey(last.segment));
    suppressedAutoRef.current.add(segmentKey(last.segment));
    skipTo(last.from);
    setUndoSkip(null);
    showHint('已撤回跳过');
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 video:ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = (ending?: ResolvedSegment) => {
    const art = artRef.current;
    if (ending) handledSegmentsRef.current.add(segmentKey(ending));
    endedRef.current = true;
    updateSkipPrompt(null);
    setUndoSkip(null);
    try {
      art?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    playbackCallbacks.current.onEnded?.();
  };

  const saveActiveProgress = () => {
    const art = artRef.current;
    if (art && !endedRef.current && playbackStartedRef.current) {
      playbackCallbacks.current.onPause?.(art.currentTime, art.duration);
    }
  };

  const startMedia = (video: HTMLVideoElement, targetUrl: string, position?: number) => {
    saveActiveProgress();
    playerSession.current?.dispose();
    cancelWarmup();
    const p = propsRef.current;
    playbackCallbacks.current = { onTimeUpdate: p.onTimeUpdate, onPause: p.onPause, onEnded: p.onEnded };
    streamInfoRef.current = {};
    playbackStartedRef.current = false;
    restoredRef.current = false;
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    setUndoSkip(null);
    failedPosition.current = null;
    setError('');
    setShowPoster(true);
    setAutoplayBlocked(false);
    playerSession.current = createVodPlayback(video, {
      url: targetUrl,
      key: p.episodeKey,
      adFilter: p.adFilter,
      restore: () => position ?? p.getRestorePosition?.() ?? 0,
      onFrame: () => {
        playbackStartedRef.current = true;
        restoredRef.current = true;
        lastSampleRef.current = video.currentTime;
        setShowPoster(false);
        setAutoplayBlocked(false);
      },
      onAutoplayBlocked: () => setAutoplayBlocked(true),
      onRestored: seconds => showHint(`已从 ${formatTime(seconds)} 继续播放`),
      onHint: showHint,
      onError: (message, started, position, duration) => {
        cancelWarmup();
        failedPosition.current = position;
        setError(message);
        if (started) {
          playbackCallbacks.current.onPause?.(position, duration);
          requestSwitchSource(message);
        }
      },
      onQuality: reportQuality,
    });
  };

  const loadEpisode = (targetUrl: string, position?: number) => {
    const video = artRef.current?.video;
    if (video && targetUrl) startMedia(video, targetUrl, position);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;
    // 触屏不走 ArtPlayer 自带隐藏计时：合成 mousemove 会把控制栏瞬间翻掉（issue #937）。
    // static 保持不自动隐藏，点按后再由 attachTouchControlHide 收起。
    const touchPointer = prefersTouchPointer();
    Artplayer.CONTROL_HIDE_TIME = touchPointer ? TOUCH_CONTROL_HIDE_MS : DESKTOP_CONTROL_HIDE_MS;

    let lastSave = 0;

    // 原生按钮保留 Tab / Enter / 空格操作，面板挂进播放器，浏览器全屏时仍可使用。
    const speedButton = document.createElement('button');
    speedButton.type = 'button';
    speedButton.className = 'watch-control-label';
    speedButton.textContent = '倍速';
    speedButton.setAttribute('aria-label', '播放速度');
    speedButton.setAttribute('aria-haspopup', 'dialog');
    speedButton.onclick = () => setMenu((prev) => prev === 'speed' ? null : 'speed');
    const episodeButton = document.createElement('button');
    episodeButton.type = 'button';
    episodeButton.className = 'watch-control-label';
    episodeButton.textContent = '选集';
    episodeButton.setAttribute('aria-label', '播放器内选集');
    episodeButton.setAttribute('aria-haspopup', 'dialog');
    episodeButton.onclick = () => setMenu((prev) => prev === 'episodes' ? null : 'episodes');
    const toolsButton = document.createElement('button');
    toolsButton.type = 'button';
    toolsButton.className = 'watch-control-label';
    toolsButton.textContent = '功能';
    toolsButton.setAttribute('aria-label', '画面、定时和循环');
    toolsButton.setAttribute('aria-haspopup', 'dialog');
    toolsButton.onclick = () => setMenu((prev) => prev === 'tools' ? null : 'tools');

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'vod',
      volume: 0.8,
      autoplay: false,
      pip: true,
      autoMini: !touchPointer,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: !touchPointer,
      // 细进度条恒传 true，不跟设置项走：库的 miniProgressBar 插件只在构造时注册、运行时不可换，
      // 而它正是「控制栏显示时摘掉 art-mini-progress-bar」的唯一维护者。设置项只负责
      // 「关掉时不保留类名」（见下方 control 监听 + 开关变化的 useEffect）。
      // 若这里按设置传 false，播放中把开关拨回「开」就没人再管这个类名，只能手动挂类，
      // 而挂上去就会常驻——同组 CSS 会连带关掉底部渐变遮罩与进度圆点（实测过）。
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#38bdf8',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      // 上/下集放在播放键右侧：换集是看剧最高频的动作，不该让用户滚回页面下方找按钮
      controls: [
        { name: 'quick-speed', index: 5, position: 'right', html: speedButton },
        { name: 'episode-menu', index: 6, position: 'right', html: episodeButton },
        ...(touchPointer ? [{ name: 'tools', index: 7, position: 'right' as const, html: toolsButton }] : []),
        ...(!touchPointer && propsRef.current.onRequestSwitchSource ? [{
          name: 'switch-source', index: 7, position: 'right' as const,
          html: '<button type="button" class="watch-control-label" aria-label="换源">换源</button>',
          click: () => requestSwitchSource(''),
        }] : []),
        {
          name: 'prev-episode',
          index: 11,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>',
          tooltip: '上一集 (Alt+←)',
          click: () => {
            if (propsRef.current.hasPrevEpisode) propsRef.current.onPrevEpisode?.();
          },
        },
        {
          name: 'next-episode',
          index: 12,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
          tooltip: '下一集 (Alt+→)',
          click: () => {
            if (propsRef.current.hasNextEpisode) propsRef.current.onNextEpisode?.();
          },
        },
      ],
      customType: {
        vod: (video: HTMLVideoElement, mediaUrl: string) => startMedia(video, mediaUrl),
      },
    });
    artRef.current = art;
    art.template.$player.classList.add('watch-artplayer');
    setOverlayHost(art.template.$player);
    const mobileFullscreen = touchPointer ? attachMobileFullscreen(art.template.$player) : null;
    const releaseTouchControls = touchPointer ? attachTouchControlHide(art) : null;
    // 触摸手势不看 hover 媒体查询：不少手机浏览器报 hover: hover，查不到就被整段跳过。
    // 鼠标不会产生 touch 事件，桌面点击不受影响。
    const releaseGestures = attachMobilePlayer(art.template.$player, {
      getVideo: () => art.video,
      allowSeek: true,
      allowRateBoost: true,
      getLocked: () => lockedRef.current,
      onHud: (hud) => hudSetter.current(hud),
    });
    const releaseScrub = attachProgressScrub(art.template.$player, {
      getVideo: () => art.video,
      onActive: () => { art.controls.show = true; },
    });
    if (lockedRef.current) art.template.$player.classList.add('is-gesture-locked');

    // 音量放大：起播后（src 已就绪）才挂 Web Audio 增益图，避免空 src / CORS 误判。
    // 默认关闭（设置项 volumeBoost）：不接入时完全不碰音频链路。
    // 纯附加：不改动 ArtPlayer 的 volume/滑块/快捷键；失败时原样播放。
    art.on('video:playing', () => {
      if (!propsRef.current.volumeBoost) return;
      if (!volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(art.video);
      }
    });

    // 底部细进度条：库插件先按 control 事件挂/摘类，我们紧随其后把类名收敛到
    // 「设置开启 且 控制栏已收起」这一个目标态。本监听注册在构造之后，同一次事件里
    // 跑在插件处理器后面，所以关闭态下刚挂上的类会立刻被摘掉，收起后什么都不留。
    art.on('control', (show: boolean) => {
      syncMiniProgressBar(art.template?.$player?.classList, {
        enabled: propsRef.current.miniProgressBar,
        controlsShown: show,
      });
    });

    // 进度条区间可视化：初始渲染一次，换集 duration 变化时重绘
    renderSkipMarks();
    art.on('video:durationchange', renderSkipMarks);
    // 全屏切换 / 播放器尺寸变化会重建控件，色带随之被清掉，这里补一次重绘
    art.on('fullscreen', renderSkipMarks);
    art.on('fullscreenWeb', renderSkipMarks);
    art.on('resize', renderSkipMarks);

    /**
     * 倍速跨集保持（issue #955）。
     *
     * 换源会让媒体元素重新走一遍 load 算法，而该算法只动一个播放属性：
     * `playbackRate = defaultPlaybackRate`。所以只要让 defaultPlaybackRate 始终
     * 等于用户选的倍速，这次「归位」就变成空操作——而且一次覆盖全部重载路径：
     * 换集、直连失败转代理、video:error 重建，以及 hls.js 内部
     * recoverMediaError 的 detach/attach（那条路径不经过 setupHls，只在
     * loadEpisode 里补写 playbackRate 是够不着的）。
     *
     * 判断依据：归位时新值必然等于 defaultPlaybackRate，跳过即可。必须跳过——
     * 归位确实会派发 ratechange，无差别同步会把默认值自己写成 1，机制当场失效。
     */
    art.on('video:ratechange', () => {
      const video = art.video;
      setPlaybackRate(video.playbackRate);
      speedButton.textContent = video.playbackRate === 1 ? '倍速' : `${video.playbackRate}×`;
      // 长按的 3 倍速是临时的，不能写进默认倍速，否则松手后会被下一次加载弹回去。
      if (video && video.dataset.boosting !== '1' && video.playbackRate !== video.defaultPlaybackRate) {
        video.defaultPlaybackRate = video.playbackRate;
      }
    });

    // 播放页「记录当前」需要精确时间：不能依赖 5s 节流的 onTimeUpdate
    propsRef.current.onPlayerApi?.({
      getFullscreenHost: () => {
        const fullscreen = document.fullscreenElement;
        if (fullscreen instanceof HTMLElement && fullscreen !== art.video && fullscreen.contains(art.video)) return fullscreen;
        const host = art.template.$player as HTMLElement;
        return art.fullscreenWeb || host.classList.contains('is-mobile-fullscreen') ? host : null;
      },
      getCurrentTime: () => {
        const current = failedPosition.current ?? artRef.current?.currentTime;
        return typeof current === 'number' && Number.isFinite(current) ? current : 0;
      },
      getDuration: () => {
        const duration = artRef.current?.duration;
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
      },
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        try {
          artRef.current.currentTime = seconds;
        } catch {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          artRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      isPaused: () => artRef.current?.video?.paused ?? true,
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      const width = art.video?.videoWidth;
      if (height > 0 && width > 0) reportQuality({ width, height });
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
    // resize 不在 ArtPlayer 的视频事件转发表里，直接挂原生事件
    art.video?.addEventListener('resize', reportVideoHeight);

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:timeupdate', () => {
      const loop = abRef.current;
      if (loop.a != null && loop.b != null && loop.b > loop.a && art.currentTime >= loop.b) {
        try { art.currentTime = loop.a; } catch { /* 忽略 */ }
        return;
      }
      const now = Date.now();
      if (playbackStartedRef.current && now - lastSave > 5000) {
        lastSave = now;
        playbackCallbacks.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      maybeWarmNext(art.video);
      // —— 跳过片段判定 ——
      const p = propsRef.current;
      const current = art.currentTime;
      const duration = art.duration;
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const segments = resolveSegments(p.skipMark, duration);

      // 结尾片段：只认连续播放越过起点；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。是否结束由合并后的 autoSkipSegments 控制
      // （片头/中段跳段，片尾结束本集，是否连播下一集仍看 autoplayNext）。
      if (
        p.autoSkipSegments &&
        restoredRef.current &&
        playbackStartedRef.current &&
        findCrossedEnding(segments, previous, current)
      ) {
        const ending = segments.find(
          (s) => s.type === 'ending' && previous < s.start && current >= s.start
        );
        finishBySkip(ending);
        return;
      }

      // 片头/中段片段：命中则自动跳到末尾（同一类操作，共用 autoSkipSegments 开关）；
      // 已处理过的片段本集不再反复拉扯。
      const active = findActiveSegment(segments, current);
      if (
        active &&
        active.type !== 'ending' &&
        p.autoSkipSegments &&
        !handledSegmentsRef.current.has(segmentKey(active)) &&
        !suppressedAutoRef.current.has(segmentKey(active)) &&
        restoredRef.current &&
        playbackStartedRef.current
      ) {
        if (skipTo(active.end)) {
          handledSegmentsRef.current.add(segmentKey(active));
          rememberSkip(current, active);
          showHint(active.type === 'opening' ? '已跳过片头' : '已跳过中段');
        }
      }

      // 按钮提示：当前落在某个未处理片段内（结尾片段显示「跳过片尾」）
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:seeked', () => {
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      // 暂停中 seek 不会触发 timeupdate，这里也同步刷新按钮的显隐。
      const current = art.currentTime;
      lastSampleRef.current = current;
      const segments = resolveSegments(propsRef.current.skipMark, art.duration);
      const active = findActiveSegment(segments, current);
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:pause', () => {
      saveActiveProgress();
      cancelWarmup();
    });
    art.on('video:seeking', cancelWarmup);
    art.on('video:waiting', cancelWarmup);
    art.on('video:ended', () => {
      // finishBySkip 已经手动走过结束链路：这里不能重复触发 onEnded
      if (endedRef.current) return;
      endedRef.current = true;
      updateSkipPrompt(null);
      playbackCallbacks.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活。
      // target 不一定是元素（例如事件打到 document 上）。
      if (!(target instanceof Element)) return;
      if (target.closest('input, textarea, select, button, [contenteditable="true"], [role="dialog"]')) return;
      if (e.ctrlKey || e.metaKey) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          if (mobileFullscreen) mobileFullscreen.toggle();
          else current.fullscreen = !current.fullscreen;
          e.preventDefault();
          break;
        // 标记类快捷键一律要求 Shift：这几键会直接写盘并影响整部剧，
        // 单键太容易误触（误记片头 = 之后每集都被跳过一大段）
        case 'i': case 'I':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'opening',
            start: 0,
            end: round1(current.currentTime),
          });
          e.preventDefault();
          break;
        case 'o': case 'O':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'ending',
            start: round1(current.currentTime),
            end: -1,
          });
          e.preventDefault();
          break;
        case 's': case 'S':
          if (!e.shiftKey) break;
          propsRef.current.onPendingStart(round1(current.currentTime));
          showHint('片段起点已记录，播放到终点后按 Shift+E');
          e.preventDefault();
          break;
        case 'e': case 'E': {
          if (!e.shiftKey) break;
          const start = propsRef.current.pendingStart;
          if (start === null) {
            showHint('请先按 Shift+S 记录片段起点');
          } else {
            const end = round1(current.currentTime);
            propsRef.current.onPendingStart(null);
            propsRef.current.onRecordSegment?.({ type: 'middle', start, end });
          }
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', shortcuts);

    const el = containerRef.current;

    // 全屏时播放器覆盖整个视口，无法依赖 mouseleave 判断“移出播放器”。
    // 改为按鼠标活动计时：停止移动后快速收起控制栏，移动时立即显示。
    let controlHideTimer: ReturnType<typeof setTimeout> | null = null;
    const showControlsOnPointerMove = () => {
      art.controls.show = true;
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        if (!art.setting.show) art.controls.show = false;
      }, 800);
    };
    const hideControlsOnMouseLeave = () => {
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = null;
      art.controls.show = false;
    };
    // 触屏不监听 mousemove/mouseleave，也跳过初始显示：iOS 点按视频的合成事件
    // 序列是 mousemove → click，若 mousemove 先把 show 置 true，紧跟的 ArtPlayer
    // click toggle 会把它翻回 false——控制栏「闪一下即隐」，正是 issue #937 的病灶
    if (!touchPointer) {
      el?.addEventListener('mousemove', showControlsOnPointerMove);
      el?.addEventListener('mouseleave', hideControlsOnMouseLeave);
      showControlsOnPointerMove();
    }

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        saveActiveProgress();
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      saveActiveProgress();
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      art.video?.removeEventListener('resize', reportVideoHeight);
      el?.removeEventListener('mousemove', showControlsOnPointerMove);
      el?.removeEventListener('mouseleave', hideControlsOnMouseLeave);
      if (controlHideTimer) clearTimeout(controlHideTimer);
      Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      mobileFullscreen?.dispose();
      releaseTouchControls?.();
      releaseGestures();
      releaseScrub();
      playerSession.current?.dispose();
      playerSession.current = null;
      cancelWarmup();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 音量放大开关：播放中改设置即时生效，不必等重新起播 ——
  // 关闭走「单位增益直通」而不是拆链：createMediaElementSource 之后元素输出只走
  // 音频图，拆链会永久静音且无法恢复直连，所以只旁路增益与限幅。
  useEffect(() => {
    const video = artRef.current?.video as HTMLVideoElement | undefined;
    if (!video) return;
    if (volumeBoost) {
      volumeBoostRef.current = attachVolumeBoost(video) ?? volumeBoostRef.current;
      volumeBoostRef.current?.setBoost(true);
    } else {
      volumeBoostRef.current?.setBoost(false);
    }
  }, [volumeBoost]);

  // —— 底部细进度条开关：播放中改设置即时生效，不用重开视频 ——
  // 按「当前可见状态 + 设置」收敛，而不是无条件挂类：控制栏可见时挂着类名虽然不会让
  // 控制栏跳位（库样式里 art-control-show 的规则排在后面），但同组的
  // background-image:none 与 .art-progress-indicator{display:none!important} 会无条件
  // 生效——底部渐变遮罩和进度圆点就这么没了。所以任何时候都不留常驻类名。
  useEffect(() => {
    const player = artRef.current?.template?.$player;
    if (!player) return;
    syncMiniProgressBar(player.classList, {
      enabled: miniProgressBar,
      controlsShown: player.classList.contains(CONTROL_SHOW_CLASS),
    });
  }, [miniProgressBar]);

  // —— 上/下集禁用态：走 ArtPlayer 的 controls API 更新样式，不直接改 DOM ——
  // 直接 querySelector 改 style 在控件重建（切全屏/播放器重绘）后不会恢复，且依赖内部 class 名。
  useEffect(() => {
    const controls = artRef.current?.controls;
    if (!controls) return;
    controls.update({
      name: 'prev-episode',
      style: { opacity: hasPrevEpisode ? '1' : '0.4', pointerEvents: hasPrevEpisode ? 'auto' : 'none' },
    });
    controls.update({
      name: 'next-episode',
      style: { opacity: hasNextEpisode ? '1' : '0.4', pointerEvents: hasNextEpisode ? 'auto' : 'none' },
    });
    controls.update({ name: 'episode-menu', style: { display: episodeCount > 1 ? 'flex' : 'none' } });
  }, [hasPrevEpisode, hasNextEpisode, episodeCount, url]);

  // —— 标记变化：重置采样基准并立即刷新提示 ——
  // 刚写入片段时当前时间可能恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场触发；把基准拉平后本集只保留手动按钮，下一集才自动。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const current = art.currentTime;
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const segments = resolveSegments(skipMark, art.duration);
    const active = findActiveSegment(segments, current);
    const prompt =
      active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
    updateSkipPrompt(prompt);
    renderSkipMarks();
  }, [skipMark]);

  // —— 复用同一个视频元素切集，保留网页全屏等状态 ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    abRef.current = { a: null, b: null };
    setAbLoop({ a: null, b: null });
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, episodeKey]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && playerSession.current) loadEpisode(propsRef.current.url, artRef.current.currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  const applyAspect = (mode: 'default' | 'cover' | '16:9' | '4:3') => {
    const player = artRef.current;
    const video = player?.video as HTMLVideoElement | undefined;
    if (!player || !video) return;
    setAspect(mode);
    try { player.aspectRatio = mode === 'cover' ? 'default' : mode; } catch { /* 播放器未就绪 */ }
    video.style.objectFit = mode === 'cover' ? 'cover' : '';
  };
  const armSleep = (minutes: number | null) => {
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = null;
    setSleepMin(minutes);
    if (minutes == null) {
      showHint('已取消定时关闭');
      return;
    }
    sleepTimerRef.current = setTimeout(() => {
      sleepTimerRef.current = null;
      setSleepMin(null);
      try { artRef.current?.pause(); } catch { /* 忽略 */ }
      showHint('定时关闭，已暂停');
    }, minutes * 60_000);
    showHint(`${minutes} 分钟后暂停`);
  };
  const markLoopStart = () => {
    const time = round1(artRef.current?.currentTime ?? 0);
    const next = { a: time, b: abRef.current.b != null && abRef.current.b > time ? abRef.current.b : null };
    abRef.current = next;
    setAbLoop(next);
    showHint('已记录循环起点');
  };
  const markLoopEnd = () => {
    const start = abRef.current.a;
    const time = round1(artRef.current?.currentTime ?? 0);
    if (start == null) { showHint('请先设循环起点'); return; }
    if (time <= start) { showHint('终点需要晚于起点'); return; }
    const next = { a: start, b: time };
    abRef.current = next;
    setAbLoop(next);
    showHint('已开始 AB 循环');
  };
  const takeScreenshot = () => {
    try {
      artRef.current?.screenshot?.();
      setMenu(null);
    } catch {
      showHint('当前画面无法截图');
    }
  };
  const togglePip = async () => {
    const video = artRef.current?.video as (HTMLVideoElement & {
      webkitSetPresentationMode?: (mode: string) => void;
      webkitPresentationMode?: string;
    }) | undefined;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
        setMenu(null);
        return;
      }
      if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
        setMenu(null);
        return;
      }
      showHint('这个浏览器没有画中画');
    } catch {
      showHint('画中画被浏览器拒绝');
    }
  };
  const toggleLock = () => {
    const next = !lockedRef.current;
    lockedRef.current = next;
    setLocked(next);
    const root = artRef.current?.template?.$player as HTMLElement | undefined;
    root?.classList.toggle('is-gesture-locked', next);
    if (next) {
      try { artRef.current.controls.show = false; } catch { /* 忽略 */ }
      setMenu(null);
    }
  };

  return (
    <div className="watch-player relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {overlayHost && createPortal(
        <>
          <div className="watch-player-title">
            <span>{title}</span><span>{episodeCount > 1 ? `第 ${currentEpisode + 1} 集 · ` : ''}{sourceName}</span>
          </div>
          {menu && (
            <div className="watch-menu-backdrop" onClick={() => setMenu(null)}>
              <div ref={menuRef} role="dialog" aria-modal="true" aria-label={menu === 'speed' ? '播放速度' : menu === 'episodes' ? '播放器内选集' : '播放功能'} tabIndex={-1} className="watch-player-menu" onClick={(event) => event.stopPropagation()}>
                <div className="watch-player-menu-heading">
                  <h2>{menu === 'speed' ? '播放速度' : menu === 'episodes' ? `选集 · 共 ${episodeCount} 集` : '播放功能'}</h2>
                  <button type="button" aria-label="关闭播放器面板" onClick={() => setMenu(null)}><Icon name="close" className="w-4 h-4" /></button>
                </div>
                {menu === 'tools' ? (
                  <div>
                    <p className="watch-tool-label">画面</p>
                    <div className="watch-speed-options">
                      {(['default', 'cover', '16:9', '4:3'] as const).map((mode) => (
                        <button key={mode} type="button" aria-pressed={aspect === mode} onClick={() => applyAspect(mode)}>
                          {mode === 'default' ? '适应' : mode === 'cover' ? '铺满' : mode}
                        </button>
                      ))}
                    </div>
                    <p className="watch-tool-label">定时关闭</p>
                    <div className="watch-speed-options">
                      {([null, 15, 30, 60] as const).map((minutes) => (
                        <button key={minutes ?? 'off'} type="button" aria-pressed={sleepMin === minutes} onClick={() => armSleep(minutes)}>
                          {minutes == null ? '关' : `${minutes} 分钟`}
                        </button>
                      ))}
                    </div>
                    <p className="watch-tool-label">AB 循环</p>
                    <p className="watch-tool-note">
                      {abLoop.a == null ? '还没有起点' : `A ${formatTime(abLoop.a)}`}
                      {abLoop.b != null ? ` · B ${formatTime(abLoop.b)}` : ''}
                    </p>
                    <div className="watch-speed-options">
                      <button type="button" onClick={markLoopStart}>设起点</button>
                      <button type="button" onClick={markLoopEnd}>设终点</button>
                      <button type="button" onClick={() => { abRef.current = { a: null, b: null }; setAbLoop({ a: null, b: null }); showHint('已取消循环'); }}>清除</button>
                    </div>
                    <p className="watch-tool-label">其他</p>
                    <div className="watch-speed-options">
                      <button type="button" onClick={takeScreenshot}>截图</button>
                      <button type="button" onClick={() => { void togglePip(); }}>画中画</button>
                      <button type="button" onClick={toggleLock}>锁屏</button>
                      {onRequestSwitchSource && <button type="button" onClick={() => { setMenu(null); requestSwitchSource(''); }}>换源</button>}
                    </div>
                  </div>
                ) : (
                  <div className={menu === 'speed' ? 'watch-speed-options' : 'watch-player-episodes'}>
                    {menu === 'speed'
                      ? [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3].map((rate) => (
                        <button key={rate} type="button" aria-pressed={playbackRate === rate} onClick={() => { if (artRef.current) artRef.current.playbackRate = rate; setMenu(null); }}>{rate === 1 ? '正常' : `${rate}×`}</button>
                      ))
                      : Array.from({ length: episodeCount }, (_, index) => (
                        <button key={index} type="button" aria-label={`播放第 ${index + 1} 集`} aria-current={index === currentEpisode ? 'true' : undefined} onClick={() => { onSelectEpisode?.(index); setMenu(null); }}>{String(index + 1).padStart(2, '0')}</button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <GestureChrome
            active={touchUi}
            hud={gestureHud}
            locked={locked}
            coach="双击左侧快退、右侧快进。左右滑调整进度，左侧上下滑调亮度，右侧上下滑调音量，长按临时 3 倍速。"
            onToggleLock={toggleLock}
          />
      {showPoster && !error && overlayHost && createPortal(
        <div className={cn('absolute inset-0 z-20 bg-[#050a12] flex flex-col items-center justify-center gap-3', !autoplayBlocked && 'pointer-events-none')} role="status">
          {autoplayBlocked ? (
            <button type="button" className="btn-primary" onClick={() => { void artRef.current?.video.play().catch(() => {}); }}>开始播放</button>
          ) : (
            <><div className="w-8 h-8 rounded-full border-2 border-slate-700 border-t-sky-400 animate-spin" />
            <p className="text-slate-200 text-sm">正在准备播放</p></>
          )}
          <p className="text-slate-400 text-xs">{sourceName || '正在连接播放线路'}</p>
        </div>, overlayHost
      )}
      {!error && skipPrompt && (
        <button
          type="button"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => {
            if (skipPrompt.type === 'ending') {
              finishBySkip(skipPrompt);
              return;
            }
            const from = artRef.current?.currentTime ?? 0;
            if (skipTo(skipPrompt.end)) {
              handledSegmentsRef.current.add(segmentKey(skipPrompt));
              rememberSkip(from, skipPrompt);
              updateSkipPrompt(null);
              showHint(skipPrompt.type === 'opening' ? '已跳过片头' : '已跳过中段');
            }
          }}
        >
          {skipPrompt.type === 'ending'
            ? '跳过片尾'
            : skipPrompt.type === 'opening'
              ? '跳过片头'
              : '跳过中段'}
        </button>
      )}
      {error && overlayHost && createPortal(
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/90 px-6 text-center">
          <Icon name="alert" className="w-8 h-8 text-slate-400" />
          <div><p className="text-white font-medium mb-2">这条线路暂时无法播放</p><p className="text-slate-400 text-xs">{error}</p></div>
          <div className="flex gap-3">
            <button className="btn-ghost text-xs" onClick={() => loadEpisode(propsRef.current.url, failedPosition.current || undefined)}>重试播放</button>
            {onRequestSwitchSource && <button className="btn-primary text-xs" onClick={() => requestSwitchSource(error)}>切换线路</button>}
          </div>
        </div>, overlayHost
      )}
      {(hint || undoSkip) && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white animate-fade-in">
          {/* 撤销窗口比普通提示长：hint 已淡出时仍要让用户知道刚才跳过了什么 */}
          <span className="pointer-events-none">
            {hint || (undoSkip ? `已跳过${SEGMENT_LABELS[undoSkip.segment.type]}` : '')}
          </span>
          {undoSkip && (
            <button
              type="button"
              className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={undoLastSkip}
            >
              撤销
            </button>
          )}
        </div>
      )}
        </>, overlayHost
      )}
    </div>
  );
}
