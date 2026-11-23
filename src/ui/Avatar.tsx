import { useBlobUrl, useProfile } from '../state/hooks'
import { usePeers } from '../state/peers'

const COLORS = ['#10b981', '#06b6d4', '#6366f1', '#a855f7', '#f59e0b', '#ef4444', '#14b8a6', '#8b5cf6']

export function Avatar({
  id,
  size = 32,
  ring,
  showOnline,
}: {
  id: string
  size?: number
  ring?: 'unseen' | 'seen'
  showOnline?: boolean
}) {
  const profile = useProfile(id)
  const url = useBlobUrl(profile?.avatar, id)
  const online = usePeers((s) => s.online.has(id))
  const initial = (profile?.username || id).slice(0, 1).toUpperCase()
  const color = COLORS[id.charCodeAt(0) % COLORS.length]
  const pad = ring ? Math.max(2, Math.round(size / 22)) : 0

  return (
    <span className="relative inline-block shrink-0" style={{ width: size + pad * 4, height: size + pad * 4 }}>
      <span
        className={`absolute inset-0 rounded-full ${ring === 'unseen' ? 'story-ring' : ring === 'seen' ? 'bg-line' : ''}`}
        style={{ padding: pad }}
      >
        <span className="block h-full w-full rounded-full bg-bg" style={{ padding: pad }}>
          {url ? (
            <img src={url} alt="" className="h-full w-full rounded-full object-cover" draggable={false} />
          ) : (
            <span
              className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white select-none"
              style={{ background: color, fontSize: size * 0.42 }}
            >
              {initial}
            </span>
          )}
        </span>
      </span>
      {showOnline && online && (
        <span
          className="absolute right-0 bottom-0 rounded-full border-2 border-bg bg-emerald-500"
          style={{ width: Math.max(10, size / 4), height: Math.max(10, size / 4) }}
          title="Online"
        />
      )}
    </span>
  )
}
