import Dexie, { type EntityTable } from 'dexie'
import type { Identity } from './identity'
import { blobRefs, isExpired, isReplaceable, type AnyRec, type Stored } from './records'

export type FriendStatus = 'outgoing' | 'incoming' | 'accepted'

export interface Friend {
  id: string
  pub?: string
  status: FriendStatus
  addedAt: number
  /** last time we had an authenticated connection */
  lastSeen?: number
}

export interface BlobRow {
  hash: string
  mime: string
  size: number
  data: Blob
  ts: number
  /** last time this blob was displayed or served; drives cache eviction */
  lastAccess?: number
}

export interface MetaRow {
  key: string
  value: unknown
}

export interface Settings {
  relayUrls: string[]
  turnUrl: string
  turnUser: string
  turnPass: string
  lastBackupAt?: number
  theme: 'system' | 'light' | 'dark'
  /** cap for friends' cached full-size media, in MB */
  cacheLimitMB: number
}

export const defaultSettings: Settings = { relayUrls: [], turnUrl: '', turnUser: '', turnPass: '', theme: 'system', cacheLimitMB: 1024 }

export class SocialDB extends Dexie {
  meta!: EntityTable<MetaRow, 'key'>
  records!: EntityTable<Stored, 'id'>
  blobs!: EntityTable<BlobRow, 'hash'>
  friends!: EntityTable<Friend, 'id'>
  seen!: EntityTable<{ id: string; at: number }, 'id'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      meta: 'key',
      records: 'id, t, by, ts, post, target, [t+by], expiresAt',
      blobs: 'hash, ts',
      friends: 'id, status',
      seen: 'id',
    })
    this.version(2).stores({ blobs: 'hash, ts, lastAccess' })
  }
}

/** `?slot=b` lets one browser hold several independent profiles (handy for local testing). */
function dbName() {
  const slot = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('slot') : null
  return slot ? `socialp-${slot}` : 'socialp'
}

export const db = new SocialDB(dbName())

// ---------- meta helpers ----------

export async function getIdentity(): Promise<Identity | undefined> {
  return (await db.meta.get('identity'))?.value as Identity | undefined
}

export async function setIdentity(identity: Identity) {
  await db.meta.put({ key: 'identity', value: identity })
}

export async function getSettings(): Promise<Settings> {
  const s = (await db.meta.get('settings'))?.value as Partial<Settings> | undefined
  return { ...defaultSettings, ...s }
}

export async function updateSettings(patch: Partial<Settings>) {
  const s = await getSettings()
  await db.meta.put({ key: 'settings', value: { ...s, ...patch } })
}

// ---------- record storage ----------

/** Store a verified record, applying replace/tombstone/expiry rules. Returns true if anything changed. */
export async function putRecord(rec: Stored): Promise<boolean> {
  if (isExpired(rec)) return false
  return db.transaction('rw', db.records, db.blobs, async () => {
    const existing = await db.records.get(rec.id)
    if (existing) {
      if (!isReplaceable(rec.t) || existing.ts >= rec.ts) return false
    }
    if (rec.t === 'del') {
      const target = await db.records.get(rec.target)
      if (target && target.by !== rec.by) return false
      if (target) await removeRecordCascade(target)
    } else if (rec.t === 'post' || rec.t === 'comment') {
      const tomb = await db.records.get(`del:${rec.id}`)
      if (tomb && tomb.by === rec.by) return false
    }
    await db.records.put(rec)
    return true
  })
}

async function removeRecordCascade(target: Stored) {
  await db.records.delete(target.id)
  if (target.t === 'post') {
    const children = await db.records.where('post').equals(target.id).primaryKeys()
    await db.records.bulkDelete(children)
  }
}

export async function hasRecord(id: string) {
  return (await db.records.where('id').equals(id).count()) > 0
}

// ---------- blobs ----------

export async function putBlob(hash: string, data: Blob, mime: string) {
  const now = Date.now()
  await db.blobs.put({ hash, data, mime, size: data.size, ts: now, lastAccess: now })
}

const TOUCH_EVERY = 60 * 60 * 1000
/** Mark a blob as recently used (throttled to one write per hour). */
export async function touchBlob(hash: string) {
  const row = await db.blobs.get(hash)
  if (row && Date.now() - (row.lastAccess ?? row.ts) > TOUCH_EVERY) await db.blobs.update(hash, { lastAccess: Date.now() })
}

/** Remove expired stories and blobs no longer referenced by any record. */
export async function garbageCollect() {
  const now = Date.now()
  const expired = await db.records.where('expiresAt').below(now).toArray()
  for (const r of expired) await removeRecordCascade(r)

  const referenced = new Set<string>()
  await db.records.each((r: AnyRec) => blobRefs(r).forEach((h) => referenced.add(h)))
  const all = await db.blobs.toCollection().primaryKeys()
  const orphans = all.filter((h) => !referenced.has(h))
  // keep very fresh blobs: their record may still be on its way
  const fresh = new Set((await db.blobs.where('ts').above(now - 5 * 60 * 1000).primaryKeys()) as string[])
  await db.blobs.bulkDelete(orphans.filter((h) => !fresh.has(h)))
  await evictCache()
}

export const FRIEND_MEDIA_TTL = 7 * 24 * 60 * 60 * 1000

/**
 * Tiered cache eviction for friends' content:
 *  1. full-size media not viewed for 7 days is dropped (post text, likes, comments and thumbnails stay;
 *     the full file is re-fetched from peers when opened again)
 *  2. if friends' media still exceeds the configured cap, least-recently-viewed goes first.
 * My own media, all thumbnails and avatars are never evicted.
 */
export async function evictCache(opts: { all?: boolean } = {}) {
  const me = await getIdentity()
  if (!me) return { freed: 0, removed: 0 }
  const { cacheLimitMB } = await getSettings()
  const protectedHashes = new Set<string>()
  await db.records.each((r: AnyRec) => {
    if (r.by === me.id) blobRefs(r).forEach((h) => protectedHashes.add(h))
    if (r.t === 'profile' && r.avatar) protectedHashes.add(r.avatar.hash)
    if (r.t === 'post') r.media.forEach((m) => m.thumb && protectedHashes.add(m.thumb))
  })
  const now = Date.now()
  const candidates: { hash: string; size: number; last: number }[] = []
  await db.blobs.each((b) => {
    if (!protectedHashes.has(b.hash)) candidates.push({ hash: b.hash, size: b.size, last: b.lastAccess ?? b.ts })
  })
  const drop = new Set<string>()
  for (const c of candidates) if (opts.all || now - c.last > FRIEND_MEDIA_TTL) drop.add(c.hash)
  let total = candidates.filter((c) => !drop.has(c.hash)).reduce((n, c) => n + c.size, 0)
  const limit = cacheLimitMB * 1024 * 1024
  for (const c of candidates.filter((c) => !drop.has(c.hash)).sort((a, b) => a.last - b.last)) {
    if (total <= limit) break
    drop.add(c.hash)
    total -= c.size
  }
  const freed = candidates.filter((c) => drop.has(c.hash)).reduce((n, c) => n + c.size, 0)
  await db.blobs.bulkDelete([...drop])
  return { freed, removed: drop.size }
}

export async function cacheStats() {
  const me = await getIdentity()
  const mine = new Set<string>()
  if (me) await db.records.where('by').equals(me.id).each((r: AnyRec) => blobRefs(r).forEach((h) => mine.add(h)))
  let own = 0
  let friends = 0
  await db.blobs.each((b) => (mine.has(b.hash) ? (own += b.size) : (friends += b.size)))
  return { own, friends }
}

export async function wipeEverything() {
  await db.delete()
}
