// Fork modification by wavachao (2026-11-03): accurate media information and source compatibility.
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, VIDEO_DETAIL_STALE_MS, videoDetailOptions } from '@/lib/client-api';
import type { SourceConfig, SearchResultItem, VideoDetail } from '@/lib/types';
import { playbackKey, playbackScore, readPlaybackHealth, type PlaybackHealth } from '@/lib/playback-health';
import { buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { qualityKey, qualityLabel, streamQualityText } from '@/lib/quality';
import { useToast } from './toast';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { EmptyState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';
import { QualityBadge } from './quality-badge';
import { useQualityProbe } from './use-quality-probe';

interface Candidate {
  source: SourceConfig;
  result: SearchResultItem;
  ms?: number;
  ok?: boolean;
  episodes?: number;
  detail?: VideoDetail;
  health?: PlaybackHealth;
  /** 测速失败原因：失败源点开后至少能知道是超时、还是源站直接拒绝 */
  error?: string;
}

/** 候选条目的稳定标识：选中态必须绑它，绑数组下标会在测速结果重排后指错源 */
const candidateKey = (c: Candidate) => `${c.source.key}_${c.result.vodId}`;

const isCurrentCandidate = (c: Candidate, sourceKey: string, vodId: string) =>
  c.source.key === sourceKey && String(c.result.vodId) === String(vodId);

function sourceEpisode(detail: VideoDetail | undefined, index: number) {
  if (!detail) return undefined;
  const line = detail.playLines?.findIndex(entry => entry.episodes[index]) ?? -1;
  if (line >= 0) return { line, url: detail.playLines![line].episodes[index] };
  const url = detail.episodes[index];
  if (!detail.playLines?.length && url) return { line: 0, url };
}

export function SwitchSourceModal({
  currentTitle,
  currentYear,
  currentSourceKey,
  currentVodId,
  currentIndex,
  getPosition,
  onClose,
}: {
  currentTitle: string;
  currentYear?: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  getPosition: () => number;
  onClose: () => void;
}) {
  const store = useAppStore();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'searching' | 'testing' | 'done'>('searching');
  /** 封面加载失败记录（按卡片 key）；失败后降级为占位图标，避免破图 */
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  /** 当前选中的候选：存稳定 key 而不是下标，测速重排后仍然指向同一个源 */
  const [selectedKey, setSelectedKey] = useState('');
  /** 正在单独重测的候选 key：失败源给一次重试机会，失败原因不能只是死路 */
  const [retestingKey, setRetestingKey] = useState('');
  /** 重测的在途请求：换片重搜/关闭面板时中止，避免卸载后 setState */
  const retestAbortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  /** Tab 栏左右是否还有内容：没有渐隐提示，用户不知道右边还藏着源 */
  const [tabEdges, setTabEdges] = useState({ left: false, right: false });

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(true, panelRef);

  const { selectedKeys, customAPIs, envSources, yellowFilter } = store;
  const sources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索/测速与 React key 撞车
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is SourceConfig => {
        if (!s || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      });
  }, [selectedKeys, customAPIs, envSources]);

  useEffect(() => {
    // 弹窗打开期间锁定背景滚动；Esc 关闭（与其它弹窗一致）
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const seen = new Set<string>();
    const slots = Array.from({ length: 4 }, () => Promise.resolve());
    let nextSlot = 0;
    setCandidates([]);
    setPhase('searching');
    const inspect = (source: SourceConfig, results: SearchResultItem[]) => {
      if (signal.aborted || seen.has(source.key)) return;
      const title = currentTitle.normalize('NFKC').trim();
      if (!title) return;
      const sameYear = results.filter(result => !currentYear || !result.year || result.year === currentYear);
      const nameOf = (result: SearchResultItem) => result.name.normalize('NFKC').trim();
      const result = sameYear.find(entry => nameOf(entry) === title) ?? sameYear.find(entry => nameOf(entry).startsWith(title));
      if (!result) return;
      seen.add(source.key);
      const health = readPlaybackHealth(playbackKey(source.key, result.vodId, 0, currentIndex));
      const candidate: Candidate = { source, result, health };
      setPhase('testing');
      setCandidates(prev => [...prev, candidate]);
      const slot = nextSlot++ % slots.length;
      slots[slot] = slots[slot].then(async () => {
        if (signal.aborted) return;
        const options = videoDetailOptions(result.vodId, source);
        const cache = queryClient.getQueryState<VideoDetail>(options.queryKey);
        const fresh = cache?.data && Date.now() - cache.dataUpdatedAt < VIDEO_DETAIL_STALE_MS;
        const response = fresh
          ? { ok: true, detail: cache.data, ms: undefined, error: undefined }
          : await api.detailSpeed(result.vodId, source, AbortSignal.any([signal, AbortSignal.timeout(5500)]));
        if (signal.aborted) return;
        if (response.detail && !fresh) queryClient.setQueryData(options.queryKey, response.detail);
        const episode = sourceEpisode(response.detail, currentIndex);
        const health = episode ? readPlaybackHealth(playbackKey(source.key, result.vodId, episode.line, currentIndex)) : candidate.health;
        setCandidates(prev => prev.map(entry => candidateKey(entry) === candidateKey(candidate)
          ? { ...entry, ...response, health, episodes: response.detail?.episodes.length } : entry));
      });
    };

    void (async () => {
      try {
        const { list } = await api.search(currentTitle, sources, yellowFilter, {
          signal,
          onSource: outcome => {
            const source = sources.find(entry => entry.key === outcome.sourceKey);
            if (source && outcome.ok) inspect(source, outcome.list);
          },
        });
        for (const source of sources) inspect(source, list.filter(result => result.sourceKey === source.key));
      } catch {
        if (!signal.aborted && !seen.size) toast('换源搜索失败', 'error');
      }
      await Promise.allSettled(slots);
      if (!signal.aborted) setPhase('done');
    })();

    return () => {
      controller.abort();
      retestAbortRef.current?.abort();
    };
  }, [currentTitle, currentYear, currentIndex, sources, yellowFilter, queryClient, toast]);

  const { qualities, probing, progress, probeQueued, retry } = useQualityProbe(sources);
  useEffect(() => {
    const targets = candidates.filter(c => c.ok).map(c => c.result);
    if (targets.length) probeQueued(targets);
  }, [candidates, probeQueued]);

  const sorted = useMemo(() => [...candidates].sort((a, b) => {
    const aCurrent = isCurrentCandidate(a, currentSourceKey, currentVodId);
    const bCurrent = isCurrentCandidate(b, currentSourceKey, currentVodId);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const aReady = Boolean(sourceEpisode(a.detail, currentIndex));
    const bReady = Boolean(sourceEpisode(b.detail, currentIndex));
    if (aReady !== bReady) return aReady ? -1 : 1;
    if (Boolean(a.health?.failed) !== Boolean(b.health?.failed)) return a.health?.failed ? 1 : -1;
    const aScore = playbackScore(a.health);
    const bScore = playbackScore(b.health);
    if (aScore !== bScore) return aScore < bScore ? -1 : 1;
    return (a.ms ?? 99_999) - (b.ms ?? 99_999);
  }), [candidates, currentIndex, currentSourceKey, currentVodId]);

  /**
   * 面板展示的源：优先用户点过的那个；还没点过时先落到「第一个可切换的源」——
   * 打开面板的目的就是换源，默认停在「当前播放中」等于让用户多点一次。
   */
  const selected =
    sorted.find((c) => candidateKey(c) === selectedKey) ??
    sorted.find((c) => !isCurrentCandidate(c, currentSourceKey, currentVodId) && sourceEpisode(c.detail, currentIndex)) ??
    sorted[0];
  const selectedCandidateKey = selected ? candidateKey(selected) : '';

  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const update = () =>
      setTabEdges({
        left: el.scrollLeft > 4,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
      });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [sorted.length]);

  // 默认选中项常落在可视区外：滚进视野，否则高亮等于不存在
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    const active = bar.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return;
    bar.scrollTo({ left: active.offsetLeft - (bar.clientWidth - active.clientWidth) / 2, behavior: 'smooth' });
  }, [selectedCandidateKey]);

  const retest = async (c: Candidate) => {
    const key = candidateKey(c);
    setRetestingKey(key);
    retestAbortRef.current?.abort();
    const controller = new AbortController();
    retestAbortRef.current = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5500)]);
      const r = await api.detailSpeed(c.result.vodId, c.source, signal);
      if (controller.signal.aborted) return;
      if (r.detail) queryClient.setQueryData(videoDetailOptions(c.result.vodId, c.source).queryKey, r.detail);
      setCandidates(prev => prev.map(x => candidateKey(x) === key
        ? { ...x, ...r, episodes: r.detail?.episodes.length } : x));
      if (r.ok) retry([c.result]);
    } finally {
      if (retestAbortRef.current === controller) {
        retestAbortRef.current = null;
        setRetestingKey('');
      }
    }
  };

  const switchTo = (c: Candidate) => {
    const episode = sourceEpisode(c.detail, currentIndex);
    if (!episode || !c.detail) return;
    const title = c.detail.videoInfo.title || c.result.name;
    const position = title.normalize('NFKC').trim() === currentTitle.normalize('NFKC').trim() ? getPosition() : undefined;
    queryClient.setQueryData(videoDetailOptions(c.result.vodId, c.source).queryKey, c.detail);
    onClose();
    window.history.pushState(null, '', buildWatchUrl({
      sourceKey: c.source.key,
      vodId: c.result.vodId,
      index: currentIndex,
      title,
      line: episode.line,
      episodeUrl: episode.url,
      position,
      sourceUrl: c.source.url,
      detail: c.source.detail,
    }));
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center bg-black/80 sm:py-10 sm:px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-t-2xl sm:rounded-xl w-full max-w-3xl shadow-2xl p-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom))] sm:pb-5 max-h-[92vh] sm:max-h-[85vh] flex flex-col overflow-hidden animate-slide-up outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`换源：${currentTitle}`}
      >
        <div className="sm:hidden mx-auto mb-3 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />
        {/* 标题固定在滚动区之外：比 sticky 更省事，也不会有背景覆盖不到 padding 的缝隙 */}
        <div className="shrink-0 mb-4 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate" title={currentTitle}>
              {currentTitle}
            </h2>
            <p className="text-xs text-faint">
              {phase === 'searching'
                ? '正在搜索各资源...'
                : phase === 'testing'
                  ? '正在检查详情接口...'
                  : `共 ${sorted.length} 个来源 · ${sorted.filter((c) => c.ok).length} 个详情响应正常`}
            </p>
            {progress.total > 0 && (
              <p className="text-xs text-faint tabular-nums mt-0.5">
                {progress.done < progress.total
                  ? `画质探测中 ${progress.done}/${progress.total}`
                  : progress.known > 0
                    ? `画质已探到 ${progress.known}/${progress.total}`
                    : // 一个都没探到不等于失败：多为单码率/直链，说清楚省得用户以为坏了
                      '源站未提供画质'}
              </p>
            )}
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容区独占剩余高度并自己滚动：标题与拖拽条始终可见，不随内容滚走 */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {sorted.length === 0 && phase !== 'done' ? (
          <LoadingState label={phase === 'searching' ? '搜索各资源中...' : '检查详情接口中...'} />
        ) : sorted.length === 0 ? (
          <EmptyState variant="plain" title="其他点播源未找到同名资源" />
        ) : (
          <>
            {/* 横向 Tab：源多时比网格省纵向空间，手机上可直接滑动 */}
            <div className="relative">
              <div
                ref={tabBarRef}
                className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin"
                role="tablist"
                aria-label="选择播放源"
              >
                {sorted.map((c) => {
                  const isCurrent = isCurrentCandidate(c, currentSourceKey, currentVodId);
                  const key = candidateKey(c);
                  const active = selected === c;
                  const quality = qualities[qualityKey(c.source.key, c.result.vodId)];
                  const qLabel = qualityLabel(quality?.height, quality?.width);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      data-active={active}
                      aria-selected={active}
                      className={cn(
                        'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                        active ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-chip text-muted hover:bg-hover'
                      )}
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="max-w-[8rem] truncate font-medium">{c.source.name}</span>
                      {isCurrent && <span className="text-[10px] opacity-80">当前</span>}
                      {qLabel && <span className="text-[10px] tabular-nums opacity-70">{qLabel}</span>}
                      {c.ok ? (
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            (c.ms ?? 0) > 2000 ? 'bg-warning-solid' : 'bg-success-solid'
                          )}
                          title={c.ms === undefined ? '详情已缓存' : `${c.ms}ms`}
                        />
                      ) : (
                        <span className="text-[10px] text-faint">{c.ok === false ? '失败' : '检查中'}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* 左右渐隐：提示这一栏还能横向滑 */}
              {tabEdges.left && (
                <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface-raised to-transparent" />
              )}
              {tabEdges.right && (
                <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface-raised to-transparent" />
              )}
            </div>

            {/* 选中源详情：封面降到缩略图，只留速度/集数两项真正要比的数据 */}
            {selected && (() => {
              const c = selected;
              const isCurrent = isCurrentCandidate(c, currentSourceKey, currentVodId);
              const key = candidateKey(c);
              const coverFailed = imgFailed[key] ?? false;
              const qKey = qualityKey(c.source.key, c.result.vodId);
              return (
                <div className="mt-3 flex items-start gap-3 p-3 bg-card rounded-lg">
                  <div className="shrink-0 w-20 aspect-[2/3] rounded-md overflow-hidden bg-chip">
                    {c.result.pic && !coverFailed ? (
                      <SmartImage
                        url={c.result.pic}
                        mode={store.imageProxyMode}
                        customProxy={store.customImageProxy}
                        alt={c.result.name}
                        className="w-full h-full object-cover"
                        onExhausted={() => setImgFailed((prev) => ({ ...prev, [key]: true }))}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-faint">
                        <Icon name="link" className="w-5 h-5" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-sm font-semibold text-content truncate" title={c.source.name}>
                        {c.source.name}
                      </h3>
                      <QualityBadge entry={qualities[qKey]} loading={probing[qKey]} onRetry={() => retry([c.result])} />
                      {isCurrent && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">播放中</span>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:max-w-[16rem]">
                      <div className="rounded-md bg-chip px-2 py-1.5">
                        <div className="text-[10px] text-faint">详情接口响应</div>
                        <div
                          className={cn(
                            'text-xs font-medium tabular-nums',
                            c.ok === false ? 'text-danger' : (c.ms ?? 0) > 2000 ? 'text-warning' : 'text-success'
                          )}
                        >
                          {c.ok === undefined ? '检查中' : c.ok ? (c.ms === undefined ? '已缓存' : `${c.ms}ms`) : '请求失败'}
                        </div>
                      </div>
                      <div className="rounded-md bg-chip px-2 py-1.5">
                        <div className="text-[10px] text-faint">集数</div>
                        <div className="text-xs font-medium text-content">
                          {c.episodes ? `${c.episodes} 集` : '无资源'}
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-muted mt-2 break-words">{qualities[qKey] && streamQualityText(qualities[qKey])}</p>
                    {c.health && <p className="text-xs text-faint mt-1">
                      {c.health.failed ? '上次播放失败' : `实播首帧 ${((c.health.firstFrameMs ?? 0) / 1000).toFixed(1)} 秒 · 缓冲 ${(c.health.stalledMs / 1000).toFixed(1)} 秒`}
                    </p>}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {isCurrent ? (
                        <span className="text-xs text-accent">当前正在播放</span>
                      ) : (
                        <>
                          <button type="button" className="btn-primary btn-sm" disabled={!sourceEpisode(c.detail, currentIndex)} onClick={() => switchTo(c)}>
                            切换到此源
                          </button>
                          {c.ok && !sourceEpisode(c.detail, currentIndex) && <span className="text-xs text-warning">没有当前集</span>}
                        </>
                      )}
                      {c.ok === false && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          disabled={retestingKey === key}
                          onClick={() => void retest(c)}
                        >
                          {retestingKey === key ? '重测中...' : '重新检查接口'}
                        </button>
                      )}
                    </div>
                    {c.ok === false && c.error && (
                      <p className="mt-1 text-[11px] text-faint line-clamp-1" title={c.error}>
                        {c.error}
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
