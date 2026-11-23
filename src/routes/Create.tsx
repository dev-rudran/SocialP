import { ArrowLeft, Crop, ImagePlus, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { createPost } from '../core/actions'
import { ASPECTS, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, processImage, processVideo } from '../core/media'
import type { MediaRef } from '../core/records'
import { useMe } from '../state/hooks'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/common'
import { Username } from '../ui/PostCard'

interface Item {
  file: File
  url: string
  video: boolean
  pan: { x: number; y: number }
  natural?: number
}

const STORY_ASPECT = 9 / 16
const PRESETS = [
  { key: 'square', label: '1:1', value: ASPECTS.square },
  { key: 'portrait', label: '4:5', value: ASPECTS.portrait },
  { key: 'landscape', label: '1.91:1', value: ASPECTS.landscape },
  { key: 'original', label: 'Original', value: null },
] as const

export function Create() {
  const [params] = useSearchParams()
  const [kind, setKind] = useState<'post' | 'story'>(params.get('story') ? 'story' : 'post')
  const me = useMe()!
  const nav = useNavigate()
  const [items, setItems] = useState<Item[]>([])
  const [active, setActive] = useState(0)
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['key']>('square')
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const itemsRef = useRef(items)
  itemsRef.current = items
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.url)), [])

  const hasVideo = items.some((i) => i.video)
  const first = items[0]
  const aspect = useMemo(() => {
    if (kind === 'story') return STORY_ASPECT
    if (hasVideo) return first?.natural ?? 1
    const p = PRESETS.find((p) => p.key === preset)!
    return p.value ?? first?.natural ?? 1
  }, [kind, hasVideo, first, preset])

  const pick = async (files: FileList | null) => {
    setError('')
    if (!files?.length) return
    const list = [...files].slice(0, kind === 'story' ? 1 : 10)
    const next: Item[] = []
    for (const file of list) {
      const video = file.type.startsWith('video/')
      if (!video && !file.type.startsWith('image/')) continue
      if (video && file.size > MAX_VIDEO_BYTES) {
        setError(`Videos must be under ${MAX_VIDEO_BYTES / 1024 / 1024} MB and ${MAX_VIDEO_SECONDS}s.`)
        continue
      }
      const url = URL.createObjectURL(file)
      const natural = await new Promise<number>((res) => {
        if (video) {
          const v = document.createElement('video')
          v.onloadedmetadata = () => res(v.videoWidth / v.videoHeight || 1)
          v.onerror = () => res(1)
          v.src = url
        } else {
          const img = new Image()
          img.onload = () => res(img.naturalWidth / img.naturalHeight || 1)
          img.onerror = () => res(1)
          img.src = url
        }
      })
      next.push({ file, url, video, pan: { x: 0, y: 0 }, natural })
    }
    // a carousel is either one video or several photos
    const vids = next.filter((n) => n.video)
    setItems(vids.length ? [vids[0]] : next)
    setActive(0)
  }

  const share = async () => {
    setBusy(true)
    setError('')
    try {
      const media: MediaRef[] = []
      for (const it of items) media.push(it.video ? await processVideo(it.file) : await processImage(it.file, aspect, it.pan))
      await createPost(kind, media, kind === 'story' ? '' : caption, aspect)
      nav(kind === 'story' ? '/' : `/u/${me.id}`, { replace: true })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const cur = items[active]

  const onPointerDown = (e: React.PointerEvent) => {
    if (!cur || cur.video) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, pan: cur.pan }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const el = frameRef.current
    if (!d || !el) return
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    const pan = { x: clamp(d.pan.x - ((e.clientX - d.x) / el.clientWidth) * 2), y: clamp(d.pan.y - ((e.clientY - d.y) / el.clientHeight) * 2) }
    setItems((list) => list.map((it, i) => (i === active ? { ...it, pan } : it)))
  }

  return (
    <div className="mx-auto max-w-4xl px-0 sm:px-4 sm:py-8">
      <div className="flex h-12 items-center justify-between border-b border-line px-3 sm:rounded-t-xl sm:border sm:border-b-0">
        <button onClick={() => (items.length ? setItems([]) : nav(-1))} aria-label="Back">
          {items.length ? <ArrowLeft /> : <X />}
        </button>
        <div className="flex rounded-lg bg-elev p-0.5 text-sm font-semibold">
          {(['post', 'story'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded-md px-4 py-1 capitalize ${kind === k ? 'bg-bg shadow' : 'text-muted'}`}>
              {k}
            </button>
          ))}
        </div>
        <Button variant="ghost" className="px-1" disabled={!items.length || busy} onClick={share}>
          {busy ? <Loader2 className="animate-spin" size={18} /> : 'Share'}
        </Button>
      </div>

      <div className="border-line sm:rounded-b-xl sm:border md:flex">
        <div className="flex flex-1 items-center justify-center bg-elev md:min-h-[520px]">
          {!items.length ? (
            <div
              className="flex flex-col items-center gap-4 px-6 py-24 text-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                void pick(e.dataTransfer.files)
              }}
            >
              <ImagePlus size={72} strokeWidth={1} />
              <p className="text-xl">Drag photos and videos here</p>
              <Button onClick={() => fileRef.current?.click()}>Select from device</Button>
              <p className="text-xs text-muted">
                Up to 10 photos, or one video ({MAX_VIDEO_SECONDS}s / {MAX_VIDEO_BYTES / 1024 / 1024} MB). Media stays on your device and goes only to friends.
              </p>
            </div>
          ) : (
            <div className="w-full">
              <div
                ref={frameRef}
                className="relative mx-auto max-h-[70dvh] touch-none overflow-hidden bg-black select-none"
                style={{ aspectRatio: aspect, maxWidth: kind === 'story' ? 380 : undefined }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => (drag.current = null)}
              >
                {cur.video ? (
                  <video src={cur.url} className="h-full w-full object-cover" autoPlay muted loop playsInline />
                ) : (
                  <img
                    src={cur.url}
                    alt=""
                    draggable={false}
                    className="h-full w-full cursor-grab object-cover active:cursor-grabbing"
                    style={{ objectPosition: `${50 + cur.pan.x * 50}% ${50 + cur.pan.y * 50}%` }}
                  />
                )}
                {!cur.video && kind === 'post' && (
                  <div className="absolute bottom-3 left-3 flex gap-1">
                    {PRESETS.map((p) => (
                      <button
                        key={p.key}
                        onClick={() => setPreset(p.key)}
                        className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${preset === p.key ? 'bg-white text-black' : 'bg-black/60 text-white'}`}
                      >
                        {p.key === 'square' && <Crop size={12} />}
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {items.length > 1 && (
                <div className="no-scrollbar flex justify-center gap-2 overflow-x-auto p-3">
                  {items.map((it, i) => (
                    <button key={it.url} onClick={() => setActive(i)} className={`h-14 w-14 shrink-0 overflow-hidden rounded ${i === active ? 'ring-2 ring-accent' : 'opacity-60'}`}>
                      <img src={it.url} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
              {!cur.video && <p className="py-2 text-center text-xs text-muted">Drag to reposition</p>}
            </div>
          )}
        </div>

        {items.length > 0 && kind === 'post' && (
          <div className="w-full border-line p-4 md:w-[340px] md:border-l">
            <div className="mb-3 flex items-center gap-3 text-sm">
              <Avatar id={me.id} size={28} />
              <Username id={me.id} />
            </div>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={2200}
              rows={8}
              placeholder="Write a caption…"
              className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted"
            />
            <p className="text-right text-xs text-muted">{caption.length.toLocaleString()}/2,200</p>
          </div>
        )}
      </div>
      {error && <p className="p-3 text-sm text-danger">{error}</p>}
      <input ref={fileRef} type="file" accept="image/*,video/*" multiple={kind === 'post'} hidden onChange={(e) => void pick(e.target.files)} />
    </div>
  )
}
