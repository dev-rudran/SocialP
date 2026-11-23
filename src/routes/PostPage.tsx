import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, MessageCircle, MoreHorizontal, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { addComment, deleteRecord } from '../core/actions'
import { db } from '../core/db'
import type { PostRec, Stored } from '../core/records'
import { ago, agoLong } from '../lib/time'
import { useComments, useLikes, useMe } from '../state/hooks'
import { Avatar } from '../ui/Avatar'
import { copy, Empty } from '../ui/common'
import { Carousel, LikeButton, PostMenu, Username } from '../ui/PostCard'

export function PostPage() {
  const { id = '' } = useParams()
  const postId = decodeURIComponent(id)
  const post = useLiveQuery(async () => (await db.records.get(postId)) ?? null, [postId]) as Stored<PostRec> | undefined | null
  const nav = useNavigate()
  const me = useMe()
  const comments = useComments(postId)
  const likes = useLikes(postId)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)

  if (post === undefined) return null
  if (!post || post.t !== 'post')
    return (
      <Empty icon={<MessageCircle size={36} />} title="Post unavailable">
        It may have been deleted, or it hasn't reached this device yet.
      </Empty>
    )

  return (
    <div className="mx-auto max-w-[935px] sm:px-4 sm:py-8">
      <div className="flex h-12 items-center border-b border-line px-3 md:hidden">
        <button onClick={() => nav(-1)} aria-label="Back">
          <ArrowLeft />
        </button>
        <h1 className="flex-1 text-center font-semibold">Post</h1>
        <span className="w-6" />
      </div>
      <div className="flex flex-col border-line sm:border md:h-[min(85dvh,720px)] md:flex-row">
        <div className="relative bg-black md:flex-1" style={{ aspectRatio: post.aspect }}>
          <Carousel post={post} className="absolute inset-0" fit="contain" />
        </div>
        <div className="flex w-full flex-col md:w-[400px] md:border-l md:border-line">
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Avatar id={post.by} size={32} showOnline />
            <Username id={post.by} className="text-sm" />
            <button className="ml-auto" onClick={() => setMenu(true)} aria-label="More">
              <MoreHorizontal size={20} />
            </button>
          </header>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
            {post.caption && (
              <div className="flex gap-3">
                <Avatar id={post.by} size={32} />
                <p className="whitespace-pre-wrap">
                  <Username id={post.by} className="mr-1.5" />
                  {post.caption}
                  <span className="mt-1 block text-xs text-muted">{ago(post.ts)}</span>
                </p>
              </div>
            )}
            {comments.map((c) => (
              <div key={c.id} className="group flex gap-3">
                <Avatar id={c.by} size={32} />
                <p className="flex-1 break-words whitespace-pre-wrap">
                  <Username id={c.by} className="mr-1.5" />
                  {c.text}
                  <span className="mt-1 block text-xs text-muted">{ago(c.ts)}</span>
                </p>
                {c.by === me?.id && (
                  <button className="opacity-0 group-hover:opacity-100" onClick={() => void deleteRecord(c.id)} aria-label="Delete comment">
                    <Trash2 size={14} className="text-muted" />
                  </button>
                )}
              </div>
            ))}
            {!post.caption && !comments.length && <p className="py-10 text-center text-muted">No comments yet. Start the conversation.</p>}
          </div>
          <div className="border-t border-line px-4 pt-2 pb-3">
            <div className="flex items-center gap-4 py-1">
              <LikeButton postId={post.id} />
              <MessageCircle size={24} className="-scale-x-100" />
              <button onClick={() => void copy(post.id)} aria-label="Copy post ID">
                <Send size={22} />
              </button>
            </div>
            <p className="text-sm font-semibold">{likes.count ? `${likes.count} ${likes.count === 1 ? 'like' : 'likes'}` : 'Be the first to like this'}</p>
            <p className="text-[10px] tracking-wide text-muted">{agoLong(post.ts)}</p>
          </div>
          <form
            className="flex border-t border-line px-4 py-3"
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
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
            <button disabled={!draft.trim()} className="text-sm font-semibold text-accent disabled:opacity-40">
              Post
            </button>
          </form>
        </div>
      </div>
      <PostMenu post={post} open={menu} onClose={() => setMenu(false)} />
    </div>
  )
}
