/** Shared relative-time formatting (R4-04) — the one implementation for
 *  Home/WorkOverview, ThreadTree and SessionPicker style timestamps. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}
