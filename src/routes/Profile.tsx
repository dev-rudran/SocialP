import { useLiveQuery } from 'dexie-react-hooks'
import { Camera, Copy, Copy as Multi, Grid3x3, Lock, Play, QrCode, Settings, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { addFriend, removeFriend } from '../core/actions'
import { db, type Friend } from '../core/db'
import { isVideo } from '../core/media'
import type { FriendListRec, Stored } from '../core/records'
import { displayName, useMe, useProfile, useStories, useUserPosts } from '../state/hooks'
import { usePeers } from '../state/peers'
import { Avatar } from '../ui/Avatar'
import { Button, Empty, Menu, copy } from '../ui/common'
import { Thumb } from '../ui/Media'
import { ShareIdModal } from './Find'

export function Profile() {
  const { id = '' } = useParams()
  const me = useMe()!
  const nav = useNavigate()
  const isMe = id === me.id
  const profile = useProfile(id)
  const posts = useUserPosts(id)
  const stories = useStories().find((g) => g.by === id)
  const friend = useLiveQuery(() => db.friends.get(id), [id]) as Friend | undefined
  const friendList = useLiveQuery(() => db.records.get(`friends:${id}`), [id]) as Stored<FriendListRec> | undefined
  const myFriends = useLiveQuery(() => db.friends.where('status').equals('accepted').count(), [], 0)
  const online = usePeers((s) => s.online.has(id))
  const [share, setShare] = useState(false)
  const [menu, setMenu] = useState(false)

  const canSee = isMe || friend?.status === 'accepted'
  const friendCount = isMe ? myFriends : (friendList?.list.length ?? 0)
  const name = displayName(profile, id)

  return (
    <div className="mx-auto max-w-[935px] px-4 pt-4 sm:pt-8">
      <div className="mb-4 flex items-center justify-between md:hidden">
        <h1 className="truncate text-xl font-bold">{name}</h1>
        {isMe && (
          <Link to="/settings" aria-label="Settings">
            <Settings />
          </Link>
        )}
      </div>

      <header className="mb-6 flex items-center gap-6 sm:mb-10 sm:gap-20 sm:px-10">
        <Link to={stories ? `/stories/${id}` : '#'} className="shrink-0">
          <span className="sm:hidden">
            <Avatar id={id} size={80} ring={stories ? (stories.allSeen ? 'seen' : 'unseen') : undefined} />
          </span>
          <span className="hidden sm:inline">
            <Avatar id={id} size={150} ring={stories ? (stories.allSeen ? 'seen' : 'unseen') : undefined} />
          </span>
        </Link>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="hidden text-xl sm:block">{name}</h2>
            {isMe ? (
              <>
                <Link to="/settings/profile">
                  <Button variant="secondary">Edit profile</Button>
                </Link>
                <Button variant="secondary" onClick={() => setShare(true)}>
                  <QrCode size={16} /> Share ID
                </Button>
              </>
            ) : friend?.status === 'accepted' ? (
              <>
                <Button variant="secondary" onClick={() => setMenu(true)}>
                  Friends
                </Button>
                <span className={`text-xs ${online ? 'text-emerald-500' : 'text-muted'}`}>{online ? '● online' : 'offline'}</span>
              </>
            ) : friend?.status === 'outgoing' ? (
              <Button variant="secondary" onClick={() => setMenu(true)}>
                Requested
              </Button>
            ) : friend?.status === 'incoming' ? (
              <Button onClick={() => void addFriend(id)}>Accept request</Button>
            ) : (
              <Button onClick={() => void addFriend(id)}>
                <UserPlus size={16} /> Add friend
              </Button>
            )}
          </div>
          <ul className="hidden gap-10 sm:flex">
            <li>
              <b>{posts?.length ?? 0}</b> posts
            </li>
            <li>
              <b>{friendCount}</b> friends
            </li>
          </ul>
          <div className="hidden text-sm sm:block">
            <p className="font-semibold">{profile?.name}</p>
            <p className="whitespace-pre-wrap">{profile?.bio}</p>
            <button className="mt-1 flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => void copy(id)} title="Copy ID">
              {id} <Copy size={12} />
            </button>
          </div>
        </div>
      </header>

      <div className="mb-4 text-sm sm:hidden">
        <p className="font-semibold">{profile?.name}</p>
        <p className="whitespace-pre-wrap">{profile?.bio}</p>
        <button className="mt-1 flex max-w-full items-center gap-1 text-xs text-muted" onClick={() => void copy(id)}>
          <span className="truncate">{id}</span> <Copy size={12} className="shrink-0" />
        </button>
      </div>

      <ul className="-mx-4 flex justify-around border-t border-line py-3 text-center text-sm sm:hidden">
        <li>
          <b className="block">{posts?.length ?? 0}</b>
          <span className="text-muted">posts</span>
        </li>
        <li>
          <b className="block">{friendCount}</b>
          <span className="text-muted">friends</span>
        </li>
      </ul>

      <div className="-mx-4 flex justify-center border-t border-line sm:mx-0">
        <span className="-mt-px flex items-center gap-1.5 border-t border-fg py-3 text-xs font-semibold tracking-widest">
          <Grid3x3 size={14} /> POSTS
        </span>
      </div>

      {!canSee ? (
        <Empty icon={<Lock size={36} />} title="This profile is private">
          {friend?.status === 'outgoing'
            ? 'Your friend request will be delivered the next time you are both online.'
            : 'Become friends to see their photos and videos. Posts are only ever shared peer-to-peer with friends.'}
        </Empty>
      ) : posts?.length === 0 ? (
        <Empty icon={<Camera size={36} />} title={isMe ? 'Share photos' : 'No posts yet'}>
          {isMe && (
            <Link to="/create" className="font-semibold text-accent">
              Share your first photo
            </Link>
          )}
        </Empty>
      ) : (
        <div className="-mx-4 grid grid-cols-3 gap-0.5 sm:mx-0 sm:gap-1">
          {posts?.map((p) => (
            <Link key={p.id} to={`/p/${encodeURIComponent(p.id)}`} className="group relative aspect-[3/4] sm:aspect-square">
              <Thumb media={p.media[0]} owner={p.by} className="absolute inset-0" />
              <span className="absolute top-2 right-2 text-white drop-shadow">
                {p.media.length > 1 ? <Multi size={18} /> : isVideo(p.media[0]) ? <Play size={18} className="fill-white" /> : null}
              </span>
              <span className="absolute inset-0 bg-black/0 transition group-hover:bg-black/25" />
            </Link>
          ))}
        </div>
      )}

      {isMe && <ShareIdModal open={share} onClose={() => setShare(false)} />}
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        items={[
          {
            label: friend?.status === 'outgoing' ? 'Cancel request' : 'Remove friend',
            danger: true,
            onClick: () => {
              if (friend?.status === 'outgoing' || confirm(`Remove ${name}? They keep anything they already received, but get nothing new.`))
                void removeFriend(id).then(() => nav('/'))
            },
          },
          { label: 'Copy ID', onClick: () => void copy(id) },
        ]}
      />
    </div>
  )
}
