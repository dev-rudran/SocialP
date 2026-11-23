import { useLiveQuery } from 'dexie-react-hooks'
import { Camera, ShieldAlert, UserPlus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { db, getSettings } from '../core/db'
import { useFeed, useFriends, useMe } from '../state/hooks'
import { useSession } from '../state/session'
import { Avatar } from '../ui/Avatar'
import { Button, Empty } from '../ui/common'
import { PostCard, Username } from '../ui/PostCard'
import { StoriesBar } from '../ui/StoriesBar'

const BACKUP_NAG_MS = 7 * 24 * 60 * 60 * 1000

function BackupBanner() {
  const me = useMe()
  const persisted = useSession((s) => s.persisted)
  const settings = useLiveQuery(getSettings, [])
  const postCount = useLiveQuery(() => (me ? db.records.where('[t+by]').equals(['post', me.id]).count() : 0), [me?.id], 0)
  if (!settings) return null
  const stale = !settings.lastBackupAt || Date.now() - settings.lastBackupAt > BACKUP_NAG_MS
  if (!stale || (postCount === 0 && persisted !== false)) return null
  return (
    <div className="mx-3 my-3 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm sm:mx-0">
      <ShieldAlert className="mt-0.5 shrink-0 text-amber-500" size={20} />
      <div className="flex-1">
        <p className="font-semibold">Back up your profile</p>
        <p className="text-muted">
          Your profile exists only in this browser{persisted === false ? ' and the browser may clear it when storage is low' : ''}. Export an encrypted copy so you
          never lose it.
        </p>
      </div>
      <Link to="/settings/export">
        <Button className="py-1.5">Export</Button>
      </Link>
    </div>
  )
}

function SuggestionsPanel() {
  const me = useMe()!
  const friends = useFriends().filter((f) => f.status === 'accepted')
  return (
    <aside className="hidden w-[320px] shrink-0 pt-8 lg:block">
      <div className="mb-6 flex items-center gap-3">
        <Avatar id={me.id} size={44} />
        <div className="min-w-0 text-sm">
          <Username id={me.id} />
          <p className="truncate text-xs text-muted">{me.id}</p>
        </div>
      </div>
      <div className="mb-3 flex justify-between text-sm">
        <span className="font-semibold text-muted">Friends</span>
        <Link to="/find" className="text-xs font-semibold">
          Add
        </Link>
      </div>
      <div className="space-y-3">
        {friends.slice(0, 8).map((f) => (
          <div key={f.id} className="flex items-center gap-3 text-sm">
            <Avatar id={f.id} size={32} showOnline />
            <Username id={f.id} />
          </div>
        ))}
        {!friends.length && <p className="text-xs text-muted">No friends yet. Share your ID to connect.</p>}
      </div>
      <p className="mt-8 text-xs text-muted">Peer-to-peer · end-to-end encrypted transport · no servers store your posts</p>
    </aside>
  )
}

export function Feed() {
  const posts = useFeed()
  const friends = useFriends()
  return (
    <div className="mx-auto flex max-w-[935px] justify-center gap-16 sm:px-4">
      <div className="w-full max-w-[470px]">
        <StoriesBar />
        <BackupBanner />
        {posts?.length === 0 && (
          <Empty icon={friends.length ? <Camera size={36} /> : <UserPlus size={36} />} title={friends.length ? 'No posts yet' : 'Welcome to SocialP'}>
            {friends.length ? (
              <>When you or your friends share photos and videos, they'll show up here.</>
            ) : (
              <>
                Add friends with their 32-character ID, or share yours.{' '}
                <Link to="/find" className="font-semibold text-accent">
                  Find friends
                </Link>
              </>
            )}
          </Empty>
        )}
        {posts?.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
      </div>
      <SuggestionsPanel />
    </div>
  )
}
