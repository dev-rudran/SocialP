import { Bookmark, Heart, MessageCircle, MoreHorizontal, Send } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { addComment, deleteRecord, setLike } from '../core/actions'
import type { PostRec, Stored } from '../core/records'
import { ago, agoLong } from '../lib/time'
import { displayName, useComments, useLikes, useMe, useProfile } from '../state/hooks'
import { Avatar } from './Avatar'
import { Menu, copy } from './common'
import { MediaView } from './Media'

export function Username({ id, className = '' }: { id: string; className?: string }) {
  const p = useProfile(id)
  return (
    <Link to={`/u/${id}`} className={`font-semibold hover:opacity-70 ${className}`}>
      {displayName(p, id)}
    </Link>
  )
}

export function Carousel({ post, className = '', fit }: { post: Stored<PostRec>; className?: string; fit?: 'cover' | 'contain' }) {
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const many = post.media.length > 1
  return (
    <div className={className.includes('absolute') ? className : `relative ${className}`}>
      <div
        ref={ref}
        className="no-scrollbar flex h-full snap-x snap-mandatory overflow-x-auto"
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
      >
        {post.media.map((m) => (
          <MediaView key={m.hash} media={m} owner={post.by} className="h-full w-full shrink-0 snap-center" fit={fit} />
        ))}
      </div>
      {many && (
        <>
          <span className="absolute top-3 right-3 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
            {index + 1}/{post.media.length}
          </span>
          <div className="pointer-events-none absolute -bottom-5 left-1/2 flex -translate-x-1/2 gap-1">
            {post.media.map((m, i) => (
              <span key={m.hash} className={`h-1.5 w-1.5 rounded-full ${i === index ? 'bg-accent' : 'bg-line'}`} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function LikeButton({ postId, size = 24, bump }: { postId: string; size?: number; bump?: number }) {
  const likes = useLikes(postId)
  return (
    <button
      key={bump}
      onClick={() => void setLike(postId, !likes.mine)}
      className={`hover:opacity-60 ${likes.mine ? 'animate-like' : ''}`}
      aria-label={likes.mine ? 'Unlike' : 'Like'}
    >
      <Heart size={size} className={likes.mine ? 'fill-danger text-danger' : ''} />
    </button>
  )
}

export function PostMenu({ post, open, onClose }: { post: Stored<PostRec>; open: boolean; onClose: () => void }) {
  const me = useMe()
  const nav = useNavigate()
  const items = [
    { label: 'Go to post', onClick: () => nav(`/p/${encodeURIComponent(post.id)}`) },
    { label: 'Copy post ID', onClick: () => void copy(post.id) },
  ]
  if (post.by === me?.id)
    items.unshift({
      label: 'Delete',
      danger: true,
      onClick: () => {
        if (confirm('Delete this post? Friends who already have a copy will be told to delete it too.')) void deleteRecord(post.id)
      },
    } as never)
  return <Menu open={open} onClose={onClose} items={items} />
}

export function PostCard({ post }: { post: Stored<PostRec> }) {
  const likes = useLikes(post.id)
  const comments = useComments(post.id)
  const [heart, setHeart] = useState(0)
  const [menu, setMenu] = useState(false)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const nav = useNavigate()
  const lastTap = useRef(0)
  const postUrl = `/p/${encodeURIComponent(post.id)}`

  const onMediaTap = () => {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      setHeart((h) => h + 1)
      if (!likes.mine) void setLike(post.id, true)
    }
    lastTap.current = now
  }

  const long = post.caption.length > 120

  return (
    <article className="border-b border-line pb-4 sm:mb-4 sm:rounded-none sm:border-b">
      <header className="flex items-center gap-3 px-3 py-2.5 sm:px-0">
        <Avatar id={post.by} size={32} showOnline />
        <div className="flex min-w-0 items-center gap-1 text-sm">
          <Username id={post.by} />
          <span className="text-muted">• {ago(post.ts)}</span>
        </div>
        <button className="ml-auto p-1" onClick={() => setMenu(true)} aria-label="More options">
          <MoreHorizontal size={20} />
        </button>
      </header>

      <div
        className="relative max-h-[80dvh] sm:rounded-md sm:border sm:border-line"
        style={{ aspectRatio: Math.min(Math.max(post.aspect, 0.8), 1.91) }}
        onClick={onMediaTap}
      >
        <Carousel post={post} className="absolute inset-0" />
        {heart > 0 && (
          <Heart key={heart} className="animate-pop pointer-events-none absolute top-1/2 left-1/2 -mt-12 -ml-12 h-24 w-24 fill-white text-white drop-shadow-lg" />
        )}
      </div>

      <div className="px-3 sm:px-0">
        <div className="flex items-center gap-4 pt-3 pb-2">
          <LikeButton postId={post.id} bump={heart} />
          <button className="hover:opacity-60" onClick={() => nav(postUrl)} aria-label="Comment">
            <MessageCircle size={24} className="-scale-x-100" />
          </button>
          <button className="hover:opacity-60" onClick={() => void copy(post.id)} aria-label="Share">
            <Send size={22} />
          </button>
          <button className="ml-auto hover:opacity-60" aria-label="Save">
            <Bookmark size={24} />
          </button>
        </div>
        {likes.count > 0 && (
          <p className="text-sm font-semibold">
            {likes.count.toLocaleString()} {likes.count === 1 ? 'like' : 'likes'}
          </p>
        )}
        {post.caption && (
          <p className="mt-1 text-sm whitespace-pre-wrap">
            <Username id={post.by} className="mr-1.5" />
            {long && !expanded ? post.caption.slice(0, 120) + '… ' : post.caption}
            {long && !expanded && (
              <button className="text-muted" onClick={() => setExpanded(true)}>
                more
              </button>
            )}
          </p>
        )}
        {comments.length > 0 && (
          <Link to={postUrl} className="mt-1 block text-sm text-muted">
            View {comments.length === 1 ? '1 comment' : `all ${comments.length} comments`}
          </Link>
        )}
        {comments.slice(-2).map((c) => (
          <p key={c.id} className="mt-0.5 line-clamp-1 text-sm">
            <Username id={c.by} className="mr-1.5" />
            {c.text}
          </p>
        ))}
        <form
          className="mt-1 flex"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) void addComment(post.id, draft).then(() => setDraft(''))
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment…"
            maxLength={1000}
            className="flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted"
          />
          {draft.trim() && <button className="text-sm font-semibold text-accent">Post</button>}
        </form>
        <p className="mt-1 text-[10px] tracking-wide text-muted sm:hidden">{agoLong(post.ts)}</p>
      </div>
      <PostMenu post={post} open={menu} onClose={() => setMenu(false)} />
    </article>
  )
}
