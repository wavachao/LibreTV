// Fork modification by wavachao (2026-11-03): cinema layout, episode navigation and source access.
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import { SkipMarkPanel } from '@/components/skip-mark-panel';
import { skipMarkKey, validateSegment, type SkipSegment } from '@/lib/skip-marks';
import type { PlayerSkipApi } from '@/components/player-shell';
import { useToast } from '@/components/toast';
import { enqueueDownload } from '@/components/download-manager';
import { Icon } from '@/components/icon';
import { SmartImage } from '@/components/smart-image';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityKey, qualityLabel, streamQualityText } from '@/lib/quality';
import type { StreamQuality } from '@/lib/types';
import {
  clearProgress,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  db,
} from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * 播放页（唯一入口，替代旧版 watch.html → player.html 跳转链）。
 * 状态全部由 URL 驱动：/watch?source=xx&id=..&index=..&title=..
 * 集数列表由服务端详情接口获取；进度与历史走 IndexedDB。
 */
export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const { verified, checked, openLogin } = useAuth();
  const { toast } = useToast();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexParam = parseInt(searchParams.get('index') || '0', 10) || 0;

  const [reversed, setReversed] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [skipPanelOpen, setSkipPanelOpen] = useState(false);
  const [cinema, setCinema] = useState(false);
  const [episodeInput, setEpisodeInput] = useState('');
  const [streamInfo, setStreamInfo] = useState<StreamQuality>({});
  // 播放器对外暴露的精确时间读取接口（「记录当前」用），随播放器卸载置空
  const playerApiRef = useRef<PlayerSkipApi | null>(null);
  // 播放框：小屏「跳过标记」抽屉要按它的底边算剩余高度，避免压住画面
  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const [sheetMaxHeight, setSheetMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!skipPanelOpen) return;
    const measure = () => {
      // 桌面端抽屉贴右侧、整屏高，不受播放器位置影响
      if (window.matchMedia('(min-width: 1024px)').matches) {
        setSheetMaxHeight(undefined);
        return;
      }
      const box = playerFrameRef.current?.getBoundingClientRect();
      if (!box) {
        setSheetMaxHeight(undefined);
        return;
      }
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const room = viewport - box.bottom - 12;
      // 不超过视口 60%；矮窗下最多压到 160px，再小就没法用了
      setSheetMaxHeight(Math.round(Math.max(160, Math.min(viewport * 0.6, room))));
    };
    measure();
    // 只在打开与尺寸变化时测：跟着滚动实时改高度会让抽屉边滚边长，很晃
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [skipPanelOpen]);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  // 详情查询：无 id（纯直连链接分享）时跳过
  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const lineParam = Math.max(0, parseInt(searchParams.get('line') || '0', 10) || 0);
  const playLines = detailQuery.data?.playLines;
  const lineIndex = Math.min(lineParam, Math.max(0, (playLines?.length ?? 1) - 1));
  const episodes = useMemo(() => playLines?.[lineIndex]?.episodes ?? detailQuery.data?.episodes ?? [], [playLines, lineIndex, detailQuery.data]);
  const videoTitle = titleParam || detailQuery.data?.videoInfo?.title || '未知视频';

  // 当前播放地址：优先取剧集列表中的当前集，其次直连 URL 参数
  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  useEffect(() => setStreamInfo({}), [currentUrl]);

  // 跳过片段按剧名记忆：换集不变，换源到同名资源也能命中。
  // 标题缺失（直连链接）时退回 source:vodId，至少保证本源本片可用。
  const skipMarkFallback = `${sourceKey}:${vodId || currentUrl}`;
  const markKey = useMemo(
    () => skipMarkKey(videoTitle, skipMarkFallback),
    [videoTitle, skipMarkFallback]
  );
  const skipMark = store.skipMarks[markKey];
  const markedCount = skipMark?.segments.length ?? 0;

  // 中段两步态的起点：页面层持有，面板按钮与 Shift+S/E 共用同一份状态
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  // 换集清空中段两步态：起点属于上一集，不能和新集的位置拼成区间
  useEffect(() => setPendingStart(null), [sourceKey, vodId, currentIndex]);

  const goEpisode = useCallback(
    (index: number) => {
      if (!Number.isInteger(index) || index < 0 || index >= episodes.length) return;
      if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  // 进度恢复优先级：URL position 参数 > IndexedDB 记录
  const getRestorePosition = useCallback(async () => {
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    return entry?.position ?? 0;
  }, [searchParams, sourceKey, vodId, currentIndex]);

  // 写入观看历史（进入页面即记录，进度后续增量更新）
  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: detailQuery.data?.videoInfo?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl]);

  // 播放中与暂停时的进度落盘逻辑一致，共用同一回调
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (vodId) {
        saveProgress(sourceKey, vodId, currentIndex, position, duration).catch(() => {});
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration).catch(() => {});
      }
    },
    [sourceKey, vodId, currentIndex, currentUrl]
  );

  // 自动连播的 800ms 延迟切集要在卸载时取消，避免离开页面后跳转
  const autoNextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
  }, []);

  const handleEnded = useCallback(() => {
    if (vodId) clearProgress(sourceKey, vodId, currentIndex).catch(() => {});
    if (store.autoplayNext && currentIndex < episodes.length - 1) {
      autoNextTimer.current = setTimeout(() => goEpisode(currentIndex + 1), 800);
    }
  }, [store.autoplayNext, currentIndex, episodes.length, goEpisode, sourceKey, vodId]);

  // 快捷键（Shift+I/O/S/E）记录片段：校验后写入
  const handleRecordSegment = useCallback(
    (segment: SkipSegment) => {
      const duration = playerApiRef.current?.getDuration() ?? 0;
      const existing = useAppStore.getState().skipMarks[markKey]?.segments ?? [];
      const error = validateSegment(segment, duration, existing);
      if (error) {
        toast(error, 'error');
        return;
      }
      useAppStore.getState().setSkipMark(markKey, [...existing, segment]);
      const label =
        segment.type === 'opening' ? '片头结束' : segment.type === 'ending' ? '片尾开始' : '中段片段';
      // 中段命中时的表现取决于全局「自动跳过片段」，记完就说清楚，避免"标了却没反应"
      const hint =
        segment.type === 'middle'
          ? useAppStore.getState().autoSkipSegments
            ? '，命中时将自动跳过'
            : '，命中时显示跳过按钮'
          : '';
      toast(`已记录${label}${hint}`, 'success');
    },
    [markKey, toast]
  );

  // Alt+←/→ 集数切换快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        goEpisode(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < episodes.length - 1) {
        e.preventDefault();
        goEpisode(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [currentIndex, episodes.length, goEpisode]);

  const orderedEpisodes = reversed ? [...episodes].map((_, i) => episodes.length - 1 - i) : episodes.map((_, i) => i);
  const info = detailQuery.data?.videoInfo;

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-faint text-sm">{checked ? '登录后继续观看' : '正在检查访问验证…'}</p>
          {checked && <button className="btn-primary" onClick={openLogin}>访问验证</button>}
          <Link href="/" className="block text-sm text-muted">返回首页</Link>
        </div>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-content font-medium mb-2">点播源不存在</h1>
          <p className="text-sm text-muted mb-4">
            该视频来自点播源「{sourceKey}」，但它可能已被删除。请在设置中重新添加后重试。
          </p>
          <Link href="/" className="btn-primary">返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('watch-page min-h-screen flex flex-col', cinema && 'watch-cinema')}>
      <header className="watch-header">
        <div className="watch-header-inner">
          <BackButton />
          <HomeButton />
          <Link href="/" className="watch-brand">Libre<span>TV</span></Link>
          <span className="watch-header-label">观影室</span>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <Link href="/live" className="watch-header-link">电视直播</Link>
            <button
              className="watch-action watch-download"
              disabled={!currentUrl}
              onClick={() => {
                if (!currentUrl) return;
                enqueueDownload({
                  url: currentUrl,
                  // 多集才带集数后缀；单集影片（含电影）文件名就是纯标题
                  title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
                  format: 'MP4',
                });
                // 「已加入下载队列」由 DownloadManager 在真正入队后提示：
                // 这里先提示的话，用户随后取消保存位置会出现「已加入→已取消」的矛盾
              }}
            >
              <Icon name="download" className="w-4 h-4" />下载本集
            </button>
          </div>
        </div>
      </header>

      <main className="watch-main flex-1">
        <div className="watch-layout">
          <section className="min-w-0" aria-label="视频播放">
            <div ref={playerFrameRef} className="watch-frame">
              {currentUrl ? (
                <PlayerShell
                  url={currentUrl}
                  title={videoTitle}
                  sourceName={source.name}
                  episodeCount={episodes.length}
                  currentEpisode={currentIndex}
                  onSelectEpisode={goEpisode}
                  adFilter={store.adFilter}
                  autoplayNext={store.autoplayNext}
                  skipMark={skipMark}
                  autoSkipSegments={store.autoSkipSegments}
                  pendingStart={pendingStart}
                  onPendingStart={setPendingStart}
                  onPlayerApi={(api) => { playerApiRef.current = api; }}
                  onRecordSegment={handleRecordSegment}
                  episodeKey={`${sourceKey}:${vodId}:${lineIndex}:${currentIndex}`}
                  nextUrl={currentIndex + 1 < episodes.length ? episodes[currentIndex + 1] : undefined}
                  nextEpisodeKey={currentIndex + 1 < episodes.length ? `${sourceKey}:${vodId}:${lineIndex}:${currentIndex + 1}` : undefined}
                  getRestorePosition={getRestorePosition}
                  onTimeUpdate={handleProgress}
                  onPause={handleProgress}
                  onEnded={handleEnded}
                  onRequestSwitchSource={() => setSwitchOpen(true)}
                  hasPrevEpisode={currentIndex > 0}
                  hasNextEpisode={episodes.length > 0 && currentIndex < episodes.length - 1}
                  onPrevEpisode={() => goEpisode(currentIndex - 1)}
                  onNextEpisode={() => goEpisode(currentIndex + 1)}
                  onQuality={(quality) => {
                    setStreamInfo(quality);
                    // 播放实测是最权威的画质来源，回写后搜索列表里该「源 + 影片」直接显示
                    if (!sourceKey || !vodId || !quality.height || !quality.width) return;
                    useAppStore.getState().setQuality({
                      [qualityKey(sourceKey, vodId)]: { ...quality, from: 'play', timestamp: Date.now() },
                    });
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {detailQuery.isLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailQuery.isError ? '视频加载失败，请尝试其他资源' : '无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 操作栏 */}
            <div className="watch-toolbar">
              <button
                className={cn('watch-action', cinema && 'is-selected')}
                aria-pressed={cinema}
                onClick={() => setCinema((v) => !v)}
              >
                <Icon name="screen" className="w-4 h-4" />{cinema ? '退出影院' : '影院模式'}
              </button>
              <button
                className="watch-action"
                disabled={currentIndex <= 0}
                onClick={() => goEpisode(currentIndex - 1)}
              >
                上一集
              </button>
              <button
                className="watch-action"
                disabled={episodes.length === 0 || currentIndex >= episodes.length - 1}
                onClick={() => goEpisode(currentIndex + 1)}
              >
                下一集
              </button>
              <button
                className={cn('watch-action', skipPanelOpen && 'is-selected')}
                aria-expanded={skipPanelOpen}
                aria-haspopup="dialog"
                onClick={() => setSkipPanelOpen((v) => !v)}
                title={
                  markedCount > 0
                    ? `本剧已标记 ${markedCount} 段${skipMark?.enabled === false ? '（本剧跳过已关闭）' : ''}`
                    : '标记片头 / 中段 / 片尾，供本剧各集自动跳过'
                }
              >
                <Icon name="skip" className="w-4 h-4" />跳过片头片尾{markedCount > 0 ? ` (${markedCount})` : ''}
                {markedCount > 0 && skipMark?.enabled === false && (
                  <span className="ml-1 inline-block size-1.5 rounded-full bg-faint" aria-label="本剧跳过已关闭" />
                )}
              </button>
              <label className="watch-autoplay">
                <input
                  type="checkbox"
                  className="watch-switch"
                  checked={store.autoplayNext}
                  onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                />
                自动连播
              </label>
            </div>

            <div className="watch-info">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-content">{videoTitle}</h1>
                <span className="watch-now">{episodes.length > 1 ? `正在播放 · 第 ${currentIndex + 1} 集` : '正在播放'}</span>
              </div>
              <div className="watch-meta">
                {[info?.year, info?.area, info?.typeName, info?.remarks].filter(Boolean).map((text, i) => <span key={i}>{text}</span>)}
                {streamInfo.height && <span className="watch-quality">{qualityLabel(streamInfo.height, streamInfo.width)} 尺寸</span>}
              </div>
              <div className="mt-3 text-xs text-muted leading-relaxed" aria-label="播放信息">
                <p>{streamQualityText(streamInfo) || '播放信息将在媒体加载后显示'}</p>
                <p className="text-faint mt-1">码率为最近分片采样，含音频与封装；不是整片平均值。未检测到 HDR 信息时不作判断。</p>
              </div>
              <details className="watch-description">
                <summary>影片简介与快捷键 <Icon name="chevronDown" className="w-3.5 h-3.5" /></summary>
                {info?.desc && <p>{info.desc.replace(/<[^>]*>|&nbsp;/gi, ' ').replace(/\s+/g, ' ')}</p>}
                <p className="watch-keyboard"><kbd>空格</kbd> 播放 / 暂停 <kbd>← →</kbd> 快退 / 快进 <kbd>F</kbd> 全屏 <kbd>Alt + ← →</kbd> 切集</p>
              </details>
            </div>

            <SkipMarkPanel
              open={skipPanelOpen}
              onClose={() => setSkipPanelOpen(false)}
              markKey={markKey}
              pendingStart={pendingStart}
              onPendingStart={setPendingStart}
              mobileMaxHeight={sheetMaxHeight}
              getPlayerClock={() => {
                const api = playerApiRef.current;
                if (!api) return null;
                return {
                  currentTime: api.getCurrentTime(),
                  duration: api.getDuration(),
                  seek: (s) => api.seek(s),
                  pause: () => api.pause(),
                  isPaused: () => api.isPaused(),
                };
              }}
            />
          </section>

          {/* 剧集侧栏 */}
          <aside className="watch-sidebar" aria-label="剧集与播放线路">
            <div className="watch-source-card">
              <div className="watch-source-heading"><span className="watch-dot" />当前播放线路</div>
              <div className="flex items-center justify-between gap-3 mt-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-content truncate">{source.name}</p>
                  <p className="text-xs text-faint mt-1">卡顿或无法播放时可以换一条线路</p>
                </div>
                <button className="watch-source-switch" onClick={() => setSwitchOpen(true)}><Icon name="refresh" className="w-3.5 h-3.5" />换源</button>
              </div>
              {playLines && playLines.length > 1 && <label className="block text-xs text-muted mt-3">
                本源播放线路
                <select aria-label="本源播放线路" className="input w-full mt-1" value={lineIndex} onChange={(e) => {
                  const sp = new URLSearchParams(searchParams.toString());
                  sp.set('line', e.target.value);
                  sp.delete('url');
                  sp.delete('position');
                  router.replace(`/watch?${sp.toString()}`, { scroll: false });
                }}>
                  {playLines.map((line, i) => <option key={i} value={i}>{line.name} · {line.episodes.length} 集</option>)}
                </select>
              </label>}
            </div>
            <div className="watch-episode-heading">
              <h2 className="text-base font-semibold text-content">
                选集 <span className="text-xs text-faint font-normal ml-1">{episodes.length > 0 && `共 ${episodes.length} 集`}</span>
              </h2>
              {/* 排列开关紧贴它所作用的列表：放在这里才看得出它管的是这一栏的顺序 */}
              {episodes.length > 1 && (
                <button
                  className="watch-action !px-2 shrink-0"
                  onClick={() => setReversed((v) => !v)}
                  aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                  title="调整剧集列表的排列顺序"
                >
                  <Icon
                    name="arrowDown"
                    className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                  />
                  {reversed ? '正序' : '倒序'}
                </button>
              )}
            </div>
            {episodes.length === 0 ? (
              detailQuery.isLoading ? (
                <LoadingState />
              ) : (
                <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集信息'} />
              )
            ) : (
              <div className="watch-episodes scrollbar-thin">
                {orderedEpisodes.map((realIndex) => (
                  <EpisodeButton
                    key={realIndex}
                    index={realIndex}
                    active={realIndex === currentIndex}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
            {episodes.length > 1 && (
              <form className="watch-episode-jump" onSubmit={(e) => {
                e.preventDefault();
                const index = Number(episodeInput) - 1;
                if (episodeInput && Number.isInteger(index) && index >= 0 && index < episodes.length) {
                  goEpisode(index);
                  setEpisodeInput('');
                }
              }}>
                <span>跳转至</span>
                <input aria-label="跳转集数" type="number" min={1} max={episodes.length} step={1} placeholder={String(currentIndex + 1)} value={episodeInput} onChange={(e) => setEpisodeInput(e.target.value)} />
                <span>集</span>
                <button type="submit" className="watch-action ml-auto" disabled={!episodeInput}>前往</button>
              </form>
            )}
            {currentIndex < episodes.length - 1 && (
              <button className="watch-up-next" onClick={() => goEpisode(currentIndex + 1)}>
                <span className="watch-next-cover"><SmartImage url={info?.cover} mode={store.imageProxyMode} customProxy={store.customImageProxy} alt="" className="w-full h-full object-cover" /><Icon name="play" className="w-5 h-5" /></span>
                <span className="text-left"><span className="block text-xs text-faint mb-1">接下来播放</span><span className="block text-sm font-medium">第 {currentIndex + 2} 集</span></span>
                <Icon name="skip" className="w-4 h-4 ml-auto text-muted" />
              </button>
            )}
          </aside>
        </div>
      </main>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </div>
  );
}

/** 集数按钮：激活时自动滚动进可视区（长剧列表） */
function EpisodeButton({ index, active, onClick }: { index: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const button = ref.current;
    const list = button?.parentElement;
    if (!active || !button || !list) return;
    // 只滚动选集列表，手机上不把整页带离视频画面。
    const reveal = () => {
      const box = button.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      if (box.top < viewport.top) list.scrollTop += box.top - viewport.top - 3;
      else if (box.bottom > viewport.bottom) list.scrollTop += box.bottom - viewport.bottom + 3;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [active]);

  return (
    <button
      ref={ref}
      className={cn('watch-episode', active && 'is-active')}
      aria-label={`播放第 ${index + 1} 集`}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
    >
      {active && <span className="watch-equalizer" aria-hidden><i /><i /><i /></span>}{String(index + 1).padStart(2, '0')}
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      className="p-2 -ml-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

/** 首页按钮：直达首页，避免从外链进入时逐级 back */
function HomeButton() {
  return (
    <Link
      href="/"
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      aria-label="回首页"
      title="回首页"
    >
      <Icon name="home" className="w-5 h-5" />
    </Link>
  );
}
