import { useLiveQuery } from 'dexie-react-hooks'
import { Heart } from 'lucide-react'
import { Link } from 'react-router-dom'
import { acceptFriend, removeFriend } from '../core/actions'
import { db } from '../core/db'
import type { CommentRec, LikeRec, PostRec, Stored } from '../core/records'
import { ago } from '../lib/time'
import { useFriends, useMe } from '../state/hooks'
import { Avatar } from '../ui/Avatar'
import { Button, Empty } from '../ui/common'
import { Thumb } from '../ui/Media'
import { Username } from '../ui/PostCard'

export function Activity() {
  const me = useMe()!
  const requests = useFriends().filter((f) => f.status === 'incoming')
  const events = useLiveQuery(
    async () => {
      const mine = (await db.records.where('[t+by]').equals(['post', me.id]).toArray()) as Stored<PostRec>[]
      const byId = new Map(mine.map((p) => [p.id, p]))
      const acts = (await db.records.where('post').anyOf([...byId.keys()]).toArray()) as Stored<LikeRec | CommentRec>[]
      return acts
        .filter((a) => a.by !== me.id && (a.t === 'comment' || (a.t === 'like' && a.on)))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 100)
        .map((a) => ({ act: a, post: byId.get(a.post)! }))
    },
    [me.id],
    [],
  )

  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <h1 className="mb-6 text-2xl font-bold">Activity</h1>

      {requests.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 font-semibold">Friend requests</h2>
          {requests.map((f) => (
            <div key={f.id} className="flex items-center gap-3 py-2">
              <Link to={`/u/${f.id}`}>
                <Avatar id={f.id} size={44} />
              </Link>
              <div className="min-w-0 flex-1 text-sm">
                <Username id={f.id} />
                <p className="truncate font-mono text-xs text-muted">{f.id}</p>
              </div>
              <Button className="py-1.5" onClick={() => void acceptFriend(f.id)}>
                Confirm
              </Button>
              <Button variant="secondary" className="py-1.5" onClick={() => void removeFriend(f.id)}>
                Delete
              </Button>
            </div>
          ))}
        </section>
      )}

      {events.length === 0 && requests.length === 0 ? (
        <Empty icon={<Heart size={36} />} title="Activity on your posts">
          When friends like or comment on your posts, you'll see it here.
        </Empty>
      ) : (
        <section className="space-y-1">
          {events.map(({ act, post }) => (
            <Link key={act.id} to={`/p/${encodeURIComponent(post.id)}`} className="flex items-center gap-3 py-2 text-sm">
              <Avatar id={act.by} size={44} />
              <p className="min-w-0 flex-1">
                <Username id={act.by} />{' '}
                {act.t === 'like' ? 'liked your post.' : <>commented: {(act as CommentRec).text}</>} <span className="text-muted">{ago(act.ts)}</span>
              </p>
              <Thumb media={post.media[0]} owner={post.by} className="h-11 w-11 shrink-0 rounded" />
            </Link>
          ))}
        </section>
      )}
    </div>
  )
}
