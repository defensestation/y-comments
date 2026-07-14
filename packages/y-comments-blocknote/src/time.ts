/** "just now", "5m", "3h", "2d", then a locale date — GitHub-style. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  if (seconds < 86400 * 7) {
    return `${Math.floor(seconds / 86400)}d`;
  }
  return then.toLocaleDateString();
}
