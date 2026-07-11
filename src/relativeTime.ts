export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return 'Unknown'
  const diff = Date.now() - Number(ts)
  if (diff < 60_000) return 'Just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return new Date(Number(ts)).toLocaleDateString()
}
