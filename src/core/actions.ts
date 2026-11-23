import { emit } from './bus'
import { db, getIdentity, putRecord, type Friend } from './db'
import type { Identity } from './identity'
import {
  signRecord,
  STORY_TTL,
  type CommentRec,
  type DeleteRec,
  type FriendListRec,
  type LikeRec,
  type MediaRef,
  type PostRec,
  type ProfileRec,
  type Stored,
} from './records'

async function me(): Promise<Identity> {
  const id = await getIdentity()
  if (!id) throw new Error('No profile')
  return id
}

async function publish<R extends Stored>(rec: R): Promise<R> {
  await putRecord(rec)
  emit('local', rec)
  return rec
}

export async function saveProfile(p: { username: string; name: string; bio: string; avatar?: MediaRef }) {
  const rec = signRecord<ProfileRec>(await me(), { t: 'profile', ...p })
  return publish(rec)
}

export async function createPost(kind: 'post' | 'story', media: MediaRef[], caption: string, aspect: number) {
  const ts = Date.now()
  const rec = signRecord<PostRec>(await me(), {
    t: 'post',
    kind,
    media,
    caption: caption.trim(),
    aspect,
    ts,
    expiresAt: kind === 'story' ? ts + STORY_TTL : undefined,
  })
  return publish(rec)
}

export async function setLike(postId: string, on: boolean) {
  return publish(signRecord<LikeRec>(await me(), { t: 'like', post: postId, on }))
}

export async function addComment(postId: string, text: string) {
  return publish(signRecord<CommentRec>(await me(), { t: 'comment', post: postId, text: text.trim() }))
}

export async function deleteRecord(target: string) {
  return publish(signRecord<DeleteRec>(await me(), { t: 'del', target }))
}

/** Re-sign and publish my friend list (used by friends to decide who may receive my re-seeded posts). */
export async function publishFriendList() {
  const accepted = await db.friends.where('status').equals('accepted').primaryKeys()
  return publish(signRecord<FriendListRec>(await me(), { t: 'friends', list: (accepted as string[]).sort() }))
}

export async function addFriend(id: string) {
  const identity = await me()
  if (id === identity.id) throw new Error("That's your own ID")
  const existing = await db.friends.get(id)
  if (existing?.status === 'accepted') return existing
  if (existing?.status === 'incoming') return acceptFriend(id)
  const f: Friend = { id, status: 'outgoing', addedAt: Date.now() }
  await db.friends.put(f)
  emit('friends', undefined)
  return f
}

export async function acceptFriend(id: string) {
  await db.friends.update(id, { status: 'accepted' })
  await publishFriendList()
  emit('friends', undefined)
  return db.friends.get(id)
}

export async function removeFriend(id: string) {
  await db.friends.delete(id)
  await publishFriendList()
  emit('friends', undefined)
}

export async function markSeen(storyId: string) {
  await db.seen.put({ id: storyId, at: Date.now() })
}
