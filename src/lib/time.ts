export function ago(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 365 ? 'numeric' : undefined })
}

export function agoLong(ts: number, now = Date.now()) {
  const short = ago(ts, now)
  const unit = short.slice(-1)
  const n = parseInt(short)
  const words: Record<string, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day' }
  if (!words[unit] || isNaN(n)) return short.toUpperCase()
  return `${n} ${words[unit]}${n === 1 ? '' : 's'} ago`.toUpperCase()
}
