'use client';

import { useEffect, useState } from 'react';
import type { GestureHud } from '@/lib/mobile-player';
import { cn } from '@/lib/utils';

const COACH_KEY = 'libretv-gesture-coach';

/** 手势提示、亮度/音量/进度浮层，以及锁屏按钮。全屏时要画在播放器内部。 */
export function GestureChrome({
  active,
  hud,
  locked,
  coach,
  onToggleLock,
}: {
  active: boolean;
  hud: GestureHud | null;
  locked: boolean;
  coach: string;
  onToggleLock: () => void;
}) {
  const [showCoach, setShowCoach] = useState(false);
  useEffect(() => {
    if (!active) return;
    try {
      setShowCoach(sessionStorage.getItem(COACH_KEY) !== '1');
    } catch {
      setShowCoach(true);
    }
  }, [active]);
  useEffect(() => {
    if (!hud || !showCoach) return;
    setShowCoach(false);
    try { sessionStorage.setItem(COACH_KEY, '1'); } catch { /* 隐私模式忽略 */ }
  }, [hud, showCoach]);

  if (!active) return null;
  const dismiss = () => {
    setShowCoach(false);
    try { sessionStorage.setItem(COACH_KEY, '1'); } catch { /* 忽略 */ }
  };

  return (
    <>
      {hud && (
        <div className="watch-gesture-hud" role="status">
          <div>{hud.text}</div>
          {hud.level != null && (
            <div className="watch-gesture-meter" aria-hidden>
              <span style={{ width: `${Math.round(hud.level * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {showCoach && !locked && (
        <div className="watch-gesture-coach">
          <p>{coach}</p>
          <button type="button" onClick={dismiss}>知道了</button>
        </div>
      )}
      <button
        type="button"
        className={cn('watch-mobile-lock', locked && 'is-active')}
        aria-pressed={locked}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onToggleLock();
        }}
      >
        {locked ? '解锁' : '锁屏'}
      </button>
    </>
  );
}
