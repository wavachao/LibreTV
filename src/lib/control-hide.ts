/**
 * 控制栏自动隐藏策略（ArtPlayer.CONTROL_HIDE_TIME，全局 static）。
 *
 * 该值是共享状态：恢复时一律回到**库默认值**而不是「进入时的快照」——
 * 点播 / 直播两个播放器先后挂载时，快照可能已经是被上一个组件改过的值
 * （如触屏设为 MAX_SAFE_INTEGER），互相污染会把「触屏常驻」泄漏到桌面。
 * 本应用是唯一写入方，库默认值即安全基准。
 */
export const ART_DEFAULT_CONTROL_HIDE_MS = 3000;
/** 桌面：鼠标停止移动 / 离开播放器后快速收起 */
export const DESKTOP_CONTROL_HIDE_MS = 800;
/**
 * 触屏：关掉 ArtPlayer 自带隐藏（issue LibreSpark/LibreTV#937）。
 * 合成 mousemove 会把「点一下才显示」立刻翻掉，所以这条 static 保持永不触发。
 * 真正的收起在 attachTouchControlHide：点按后再等一会儿，不听 mousemove。
 */
export const TOUCH_CONTROL_HIDE_MS = Number.MAX_SAFE_INTEGER;
