import { ChevronLeft, ChevronRight, MoreHorizontal, Pause, Play, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { deleteRecord, markSeen } from '../core/actions'
import { isVideo } from '../core/media'
import { ago } from '../lib/time'
import { useMe, useStories } from '../state/hooks'
import { Avatar } from '../ui/Avatar'
import { Menu } from '../ui/common'
import { MediaView } from '../ui/Media'
import { Username } from '../ui/PostCard'

const IMAGE_MS = 5000

export function StoryViewer() {
  const { userId = '' } = useParams()
  const nav = useNavigate()
  const me = useMe()
  const groups = useStories()
  const gi = groups.findIndex((g) => g.by === userId)
  const group = groups[gi]
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [menu, setMenu] = useState(false)
  const [duration, setDuration] = useState(IMAGE_MS)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => setIndex(0), [userId])

  const story = group?.stories[Math.min(index, group.stories.length - 1)]
  const video = story ? isVideo(story.media[0]) : false

  useEffect(() => {
    if (story) void markSeen(story.id)
    setElapsed(0)
    setDuration(IMAGE_MS)
  }, [story?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => {
    if (!group) return
    if (index < group.stories.length - 1) setIndex(index + 1)
    else if (groups[gi + 1]) nav(`/stories/${groups[gi + 1].by}`, { replace: true })
    else nav('/', { replace: true })
  }
  const prev = () => {
    if (index > 0) setIndex(index - 1)
    else if (groups[gi - 1]) nav(`/stories/${groups[gi - 1].by}`, { replace: true })
  }

  // progress timer; videos advance on `ended`, images when the bar fills
  useEffect(() => {
    if (!story || paused || menu) return
    const t = setInterval(() => setElapsed((e) => e + 50), 50)
    return () => clearInterval(t)
  }, [story?.id, paused, menu]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!video && elapsed >= duration) next()
  }, [elapsed]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'Escape') nav('/')
      if (e.key === ' ') setPaused((p) => !p)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (!group || !story) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black text-white">
        <button className="absolute top-4 right-4" onClick={() => nav('/')} aria-label="Close">
          <X />
        </button>
        <p className="text-sm opacity-70">No active stories.</p>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950">
      <button className="absolute top-4 right-4 z-10 hidden text-white sm:block" onClick={() => nav('/')} aria-label="Close">
        <X size={28} />
      </button>
      <button className="absolute left-[calc(50%-260px)] hidden rounded-full bg-white/80 p-1 text-black sm:block" onClick={prev} aria-label="Previous">
        <ChevronLeft size={20} />
      </button>
      <button className="absolute right-[calc(50%-260px)] hidden rounded-full bg-white/80 p-1 text-black sm:block" onClick={next} aria-label="Next">
        <ChevronRight size={20} />
      </button>

      <div className="relative h-full w-full overflow-hidden bg-black sm:h-[min(92dvh,820px)] sm:w-auto sm:rounded-lg" style={{ aspectRatio: '9 / 16' }}>
        <MediaView
          key={story.id}
          media={story.media[0]}
          owner={story.by}
          className="absolute inset-0 bg-black"
          fit="contain"
          paused={paused || menu}
          onEnded={next}
          onDuration={(s) => setDuration(s * 1000)}
        />

        {/* tap zones */}
        <div
          className="absolute inset-0 flex"
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
        >
          <button className="h-full w-1/3" onClick={prev} aria-label="Previous story" />
          <button className="h-full w-2/3" onClick={next} aria-label="Next story" />
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/60 to-transparent p-3 pb-10">
          <div className="flex gap-1">
            {group.stories.map((s, i) => (
              <span key={s.id} className="h-0.5 flex-1 overflow-hidden rounded bg-white/35">
                <span
                  className="block h-full bg-white"
                  style={{ width: i < index ? '100%' : i === index ? `${Math.min(100, (elapsed / duration) * 100)}%` : '0%' }}
                />
              </span>
            ))}
          </div>
          <div className="pointer-events-auto mt-3 flex items-center gap-2 text-sm text-white">
            <Avatar id={story.by} size={32} />
            <Username id={story.by} />
            <span className="opacity-70">{ago(story.ts)}</span>
            <button className="ml-auto" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'}>
              {paused ? <Play size={20} /> : <Pause size={20} />}
            </button>
            {story.by === me?.id && (
              <button onClick={() => setMenu(true)} aria-label="More">
                <MoreHorizontal size={22} />
              </button>
            )}
            <button className="sm:hidden" onClick={() => nav('/')} aria-label="Close">
              <X size={24} />
            </button>
          </div>
        </div>
      </div>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        items={[{ label: 'Delete story', danger: true, onClick: () => void deleteRecord(story.id).then(next) }]}
      />
    </div>
  )
}
