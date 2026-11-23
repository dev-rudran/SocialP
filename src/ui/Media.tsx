import { Loader2, Play, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isVideo } from '../core/media'
import type { MediaRef } from '../core/records'
import { useBlobUrl } from '../state/hooks'
import { usePeers } from '../state/peers'

/** Thumbnail first, full media when available (possibly fetched from peers). */
export function MediaView({
  media,
  owner,
  className = '',
  autoPlay = true,
  fit = 'cover',
  onEnded,
  onDuration,
  paused,
}: {
  media: MediaRef
  owner: string
  className?: string
  autoPlay?: boolean
  fit?: 'cover' | 'contain'
  onEnded?: () => void
  onDuration?: (s: number) => void
  paused?: boolean
}) {
  const thumb = useBlobUrl(media.thumb ? { hash: media.thumb, mime: 'image/jpeg' } : undefined, owner)
  const full = useBlobUrl(media, owner)
  const progress = usePeers((s) => s.downloads.get(media.hash))
  const video = isVideo(media)
  const vref = useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = useState(true)
  const [playing, setPlaying] = useState(false)

  // play only while on screen, like a real feed
  useEffect(() => {
    const el = vref.current
    if (!el || !video || !autoPlay) return
    const io = new IntersectionObserver(([e]) => (e.isIntersecting && !paused ? el.play().catch(() => {}) : el.pause()), { threshold: 0.6 })
    io.observe(el)
    return () => io.disconnect()
  }, [full, video, autoPlay, paused])

  useEffect(() => {
    const el = vref.current
    if (!el) return
    if (paused) el.pause()
    else if (autoPlay) el.play().catch(() => {})
  }, [paused, autoPlay])

  const objectFit = fit === 'cover' ? 'object-cover' : 'object-contain'
  const pending = !full

  return (
    <div className={`${positioned(className)} overflow-hidden ${/(^|\s)bg-/.test(className) ? '' : 'bg-elev'}`}>
      {thumb && pending && <img src={thumb} alt="" className={`absolute inset-0 h-full w-full ${objectFit} blur-[2px]`} />}
      {full && !video && <img src={full} alt="" className={`absolute inset-0 h-full w-full ${objectFit}`} draggable={false} />}
      {full && video && (
        <>
          <video
            ref={vref}
            src={full}
            poster={thumb}
            muted={muted}
            playsInline
            loop={!onEnded}
            onEnded={onEnded}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration)}
            className={`absolute inset-0 h-full w-full ${objectFit}`}
            onClick={(e) => {
              e.stopPropagation()
              const el = e.currentTarget
              if (el.paused) el.play().catch(() => {})
              else el.pause()
            }}
          />
          {!playing && !paused && (
            <Play className="pointer-events-none absolute top-1/2 left-1/2 h-14 w-14 -translate-1/2 fill-white/90 text-white/90 drop-shadow" />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              setMuted((m) => !m)
            }}
            className="absolute right-3 bottom-3 rounded-full bg-black/60 p-1.5 text-white"
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        </>
      )}
      {pending && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-white/90">
          <Loader2 className="h-6 w-6 animate-spin drop-shadow" />
          {progress !== undefined ? (
            <span className="rounded bg-black/50 px-2 py-0.5">{Math.round(progress * 100)}%</span>
          ) : (
            !thumb && <span className="rounded bg-black/50 px-2 py-0.5 text-center">Waiting for a friend who has this to come online</span>
          )}
        </div>
      )}
    </div>
  )
}

/** `relative` unless the caller already positions the element (Tailwind can't resolve relative+absolute). */
function positioned(className: string) {
  return /(^|\s)(absolute|fixed)(\s|$)/.test(className) ? className : `relative ${className}`
}

export function Thumb({ media, owner, className = '' }: { media: MediaRef; owner: string; className?: string }) {
  const thumb = useBlobUrl(media.thumb ? { hash: media.thumb, mime: 'image/jpeg' } : media, owner)
  return (
    <div className={`${positioned(className)} overflow-hidden ${/(^|\s)bg-/.test(className) ? '' : 'bg-elev'}`}>
      {thumb && <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />}
    </div>
  )
}
