import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db, touchBlob, type Friend } from '../core/db'
import type { CommentRec, LikeRec, MediaRef, PostRec, ProfileRec, Stored } from '../core/records'
import { net } from '../p2p/net'
import { useSession } from './session'

export const useMe = () => useSession((s) => s.identity)

export function useProfile(id: string | undefined) {
  return useLiveQuery(async () => (id ? ((await db.records.get(`profile:${id}`)) as Stored<ProfileRec> | undefined) : undefined), [id])
}

export function displayName(p: ProfileRec | undefined, id: string) {
  return p?.username || `user_${id.slice(0, 6)}`
}

export function useFriends() {
  return useLiveQuery(() => db.friends.toArray(), [], [] as Friend[])
}

/** Posts from me + accepted friends, newest first. */
export function useFeed() {
  const me = useMe()
  return useLiveQuery(
    async () => {
      if (!me) return []
      const ids = [me.id, ...((await db.friends.where('status').equals('accepted').primaryKeys()) as string[])]
      const posts = (await db.records.where('t').equals('post').toArray()) as Stored<PostRec>[]
      const allowed = new Set(ids)
      return posts.filter((p) => p.kind === 'post' && allowed.has(p.by)).sort((a, b) => b.ts - a.ts)
    },
    [me?.id],
  )
}

export function useUserPosts(id: string | undefined) {
  return useLiveQuery(
    async () => {
      if (!id) return []
      const posts = (await db.records.where('[t+by]').equals(['post', id]).toArray()) as Stored<PostRec>[]
      return posts.filter((p) => p.kind === 'post').sort((a, b) => b.ts - a.ts)
    },
    [id],
  )
}

export interface StoryGroup {
  by: string
  stories: Stored<PostRec>[]
  allSeen: boolean
}

/** Active stories grouped by author: me first, then unseen, then seen. */
export function useStories() {
  const me = useMe()
  return useLiveQuery(
    async () => {
      if (!me) return [] as StoryGroup[]
      const now = Date.now()
      const accepted = new Set((await db.friends.where('status').equals('accepted').primaryKeys()) as string[])
      const stories = ((await db.records.where('expiresAt').above(now).toArray()) as Stored<PostRec>[]).filter(
        (s) => s.kind === 'story' && (s.by === me.id || accepted.has(s.by)),
      )
      const seen = new Set((await db.seen.toCollection().primaryKeys()) as string[])
      const groups = new Map<string, Stored<PostRec>[]>()
      for (const s of stories.sort((a, b) => a.ts - b.ts)) groups.set(s.by, [...(groups.get(s.by) ?? []), s])
      return [...groups]
        .map(([by, list]) => ({ by, stories: list, allSeen: list.every((s) => seen.has(s.id)) }))
        .sort((a, b) => (a.by === me.id ? -1 : b.by === me.id ? 1 : Number(a.allSeen) - Number(b.allSeen)))
    },
    [me?.id],
    [] as StoryGroup[],
  )
}

export function useLikes(postId: string) {
  const me = useMe()
  return useLiveQuery(
    async () => {
      const likes = ((await db.records.where('post').equals(postId).toArray()) as Stored<LikeRec>[]).filter((r) => r.t === 'like' && r.on)
      return { count: likes.length, mine: likes.some((l) => l.by === me?.id), likers: likes.map((l) => l.by) }
    },
    [postId, me?.id],
    { count: 0, mine: false, likers: [] as string[] },
  )
}

export function useComments(postId: string) {
  return useLiveQuery(
    async () =>
      ((await db.records.where('post').equals(postId).toArray()) as Stored<CommentRec>[])
        .filter((r) => r.t === 'comment')
        .sort((a, b) => a.ts - b.ts),
    [postId],
    [] as Stored<CommentRec>[],
  )
}

/** Object URL for a blob; asks the network for it if we don't have it locally. */
export function useBlobUrl(ref: Pick<MediaRef, 'hash' | 'mime'> | undefined, owner: string | undefined) {
  const row = useLiveQuery(() => (ref ? db.blobs.get(ref.hash) : undefined), [ref?.hash])
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!row) return
    const u = URL.createObjectURL(row.data)
    setUrl(u)
    void touchBlob(row.hash)
    return () => URL.revokeObjectURL(u)
  }, [row])
  const hash = ref?.hash
  const mime = ref?.mime
  const missing = row === undefined
  useEffect(() => {
    if (hash && mime && owner && missing) void net.fetchBlob(hash, mime, owner)
  }, [hash, mime, owner, missing])
  return row ? url : undefined
}

export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
