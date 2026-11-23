import { beforeEach, describe, expect, it } from 'vitest'
import { deriveId, generateIdentity, ID_RE, pubMatchesId } from './identity'
import { fromB64 } from '../lib/encoding'
import { signRecord, verifyRecord, type DeleteRec, type FriendListRec, type PostRec, type ProfileRec } from './records'
import { db, evictCache, putBlob, putRecord, setIdentity, updateSettings } from './db'
import { exportProfile, importProfile } from './archive'
import { buildManifest, missingFrom, shouldAccept } from '../p2p/policy'

const media = [{ hash: 'a'.repeat(64), mime: 'image/jpeg', size: 3, w: 1, h: 1 }]

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('identity', () => {
  it('derives a 32-char base32 id bound to the public key', () => {
    const me = generateIdentity()
    expect(me.id).toMatch(ID_RE)
    expect(deriveId(fromB64(me.pub))).toBe(me.id)
    expect(pubMatchesId(me.pub, me.id)).toBe(true)
    expect(pubMatchesId(generateIdentity().pub, me.id)).toBe(false)
  })
})

describe('records', () => {
  it('signs and verifies, rejects tampering and impersonation', () => {
    const me = generateIdentity()
    const post = signRecord<PostRec>(me, { t: 'post', kind: 'post', media, caption: 'hi', aspect: 1 })
    expect(verifyRecord(post)?.id).toBe(post.id)
    expect(verifyRecord({ ...post, caption: 'evil' })).toBeNull()
    const other = generateIdentity()
    expect(verifyRecord({ ...post, by: other.id })).toBeNull()
    expect(verifyRecord({ ...post, pub: other.pub })).toBeNull()
  })

  it('keeps only the newest version of replaceable records', async () => {
    const me = generateIdentity()
    const v1 = signRecord<ProfileRec>(me, { t: 'profile', username: 'a', name: '', bio: '', ts: 1 })
    const v2 = signRecord<ProfileRec>(me, { t: 'profile', username: 'b', name: '', bio: '', ts: 2 })
    expect(await putRecord(v2)).toBe(true)
    expect(await putRecord(v1)).toBe(false)
    expect(((await db.records.get(v1.id)) as ProfileRec).username).toBe('b')
  })

  it('tombstones delete posts and block re-insertion', async () => {
    const me = generateIdentity()
    const post = signRecord<PostRec>(me, { t: 'post', kind: 'post', media, caption: '', aspect: 1 })
    await putRecord(post)
    await putRecord(signRecord<DeleteRec>(me, { t: 'del', target: post.id }))
    expect(await db.records.get(post.id)).toBeUndefined()
    expect(await putRecord(post)).toBe(false)
  })
})

describe('policy', () => {
  it('re-seeds a friend’s post only to people on their signed friend list', async () => {
    const me = generateIdentity(), alice = generateIdentity(), carol = generateIdentity(), mallory = generateIdentity()
    await setIdentity(me)
    await db.friends.bulkPut([
      { id: alice.id, status: 'accepted', addedAt: 0 },
      { id: carol.id, status: 'accepted', addedAt: 0 },
      { id: mallory.id, status: 'accepted', addedAt: 0 },
    ])
    const post = signRecord<PostRec>(alice, { t: 'post', kind: 'post', media, caption: '', aspect: 1 })
    await putRecord(signRecord<FriendListRec>(alice, { t: 'friends', list: [me.id, carol.id] }))
    await putRecord(post)
    expect((await buildManifest(me.id, carol.id)).map((e) => e.id)).toContain(post.id)
    expect((await buildManifest(me.id, mallory.id)).map((e) => e.id)).not.toContain(post.id)
    expect(await shouldAccept(me.id, post)).toBe(true)
    expect(await shouldAccept(me.id, signRecord<PostRec>(generateIdentity(), { t: 'post', kind: 'post', media, caption: '', aspect: 1 }))).toBe(false)
    expect(await missingFrom([{ id: post.id, ts: post.ts }, { id: 'post:zzz', ts: 1 }])).toEqual(['post:zzz'])
  })
})

describe('archive', () => {
  it('round-trips a profile through an encrypted export', async () => {
    const me = generateIdentity()
    await setIdentity(me)
    const post = signRecord<PostRec>(me, { t: 'post', kind: 'post', media, caption: 'x', aspect: 1 })
    await putRecord(post)
    await putBlob(media[0].hash, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'image/jpeg')
    await db.friends.put({ id: 'f'.repeat(32), status: 'accepted', addedAt: 1 })

    const file = await exportProfile('correct horse battery')
    await expect(importProfile(file, 'wrong passphrase')).rejects.toThrow(/passphrase/)
    await Promise.all(db.tables.map((t) => t.clear()))

    const restored = await importProfile(file, 'correct horse battery')
    expect(restored.id).toBe(me.id)
    expect(await db.records.get(post.id)).toBeTruthy()
    expect(await db.friends.count()).toBe(1)
    const blob = await db.blobs.get(media[0].hash)
    expect(new Uint8Array(await blob!.data.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  }, 30_000)
})

describe('cache eviction', () => {
  it('drops stale friend media, enforces the cap LRU-first, and never touches my media or thumbnails', async () => {
    const me = generateIdentity(), alice = generateIdentity()
    await setIdentity(me)
    const ref = (h: string, thumb?: string) => ({ hash: h.repeat(64), mime: 'image/jpeg', size: 1, w: 1, h: 1, thumb: thumb?.repeat(64) })
    await putRecord(signRecord<PostRec>(me, { t: 'post', kind: 'post', media: [ref('a')], caption: '', aspect: 1 }))
    await putRecord(signRecord<PostRec>(alice, { t: 'post', kind: 'post', media: [ref('b', 't'), ref('c'), ref('d')], caption: '', aspect: 1 }))
    const day = 86_400_000, now = Date.now()
    const big = new Blob([new Uint8Array(600 * 1024)])
    const put = (h: string, last: number, data = new Blob([new Uint8Array(1)])) =>
      db.blobs.put({ hash: h.repeat(64), mime: 'image/jpeg', size: data.size, data, ts: last, lastAccess: last })
    await put('a', now - 30 * day) // mine, old
    await put('t', now - 30 * day) // thumbnail, old
    await put('b', now - 8 * day) // friend, stale
    await put('c', now - 2 * day, big) // friend, older of the two fresh
    await put('d', now - 1 * day, big) // friend, newest
    await updateSettings({ cacheLimitMB: 1 })
    await evictCache()
    const left = new Set((await db.blobs.toCollection().primaryKeys()).map((k) => String(k)[0]))
    expect([...left].sort()).toEqual(['a', 'd', 't'])
  })
})
