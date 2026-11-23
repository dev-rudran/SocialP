import { sha256 } from '@noble/hashes/sha2.js'
import { base32, canonical, utf8 } from '../lib/encoding'
import { pubMatchesId, signText, verifyText, type Identity } from './identity'

/**
 * Every piece of shared data is a self-verifying signed record:
 * `by` (author id) + `pub` (author pubkey, must hash to `by`) + `sig` over the canonical body.
 */

export interface MediaRef {
  hash: string
  mime: string
  size: number
  w: number
  h: number
  /** hash of a small JPEG thumbnail / video poster */
  thumb?: string
  duration?: number
}

interface Base {
  by: string
  pub: string
  ts: number
  sig: string
}

export interface ProfileRec extends Base {
  t: 'profile'
  username: string
  name: string
  bio: string
  avatar?: MediaRef
}

export interface FriendListRec extends Base {
  t: 'friends'
  list: string[]
}

export interface PostRec extends Base {
  t: 'post'
  kind: 'post' | 'story'
  media: MediaRef[]
  caption: string
  /** width / height of the frame */
  aspect: number
  expiresAt?: number
}

export interface LikeRec extends Base {
  t: 'like'
  post: string
  on: boolean
}

export interface CommentRec extends Base {
  t: 'comment'
  post: string
  text: string
}

export interface DeleteRec extends Base {
  t: 'del'
  target: string
}

export type AnyRec = ProfileRec | FriendListRec | PostRec | LikeRec | CommentRec | DeleteRec
export type RecType = AnyRec['t']
type Body<R extends AnyRec> = Omit<R, 'sig' | 'by' | 'pub' | 'ts'> & { ts?: number }

/** Stored record: signed record + derived id. */
export type Stored<R extends AnyRec = AnyRec> = R & { id: string }

export const STORY_TTL = 24 * 60 * 60 * 1000
const MAX_CLOCK_SKEW = 10 * 60 * 1000

function contentHash(rec: Omit<AnyRec, 'sig'>): string {
  return base32(sha256(utf8(canonical(rec))).slice(0, 20))
}

/** Replaceable records (profile, friend list, like, tombstone) get a stable slot id; immutable ones are content-addressed. */
export function recordId(rec: AnyRec): string {
  switch (rec.t) {
    case 'profile':
      return `profile:${rec.by}`
    case 'friends':
      return `friends:${rec.by}`
    case 'like':
      return `like:${rec.post}:${rec.by}`
    case 'del':
      return `del:${rec.target}`
    default: {
      const { sig: _sig, ...unsigned } = rec
      return `${rec.t}:${contentHash(unsigned)}`
    }
  }
}

export function isReplaceable(t: RecType) {
  return t === 'profile' || t === 'friends' || t === 'like'
}

export function signRecord<R extends AnyRec>(me: Identity, body: Body<R>): Stored<R> {
  const unsigned = { ...body, ts: body.ts ?? Date.now(), by: me.id, pub: me.pub }
  const sig = signText(canonical(unsigned), me.secret)
  const rec = { ...unsigned, sig } as unknown as R
  return { ...rec, id: recordId(rec) }
}

export function verifyRecord(input: unknown): Stored | null {
  if (!input || typeof input !== 'object') return null
  const { id: _id, ...rec } = input as Stored
  if (typeof rec.by !== 'string' || typeof rec.pub !== 'string' || typeof rec.sig !== 'string') return null
  if (typeof rec.ts !== 'number' || rec.ts > Date.now() + MAX_CLOCK_SKEW) return null
  if (!shapeOk(rec)) return null
  if (!pubMatchesId(rec.pub, rec.by)) return null
  const { sig, ...unsigned } = rec
  if (!verifyText(sig, canonical(unsigned), rec.pub)) return null
  return { ...rec, id: recordId(rec) } as Stored
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max

function mediaOk(m: unknown): boolean {
  const r = m as MediaRef
  return !!r && str(r.hash, 64) && str(r.mime, 64) && typeof r.size === 'number' && typeof r.w === 'number' && typeof r.h === 'number'
}

function shapeOk(r: AnyRec): boolean {
  switch (r.t) {
    case 'profile':
      return str(r.username, 30) && str(r.name, 60) && str(r.bio, 300) && (r.avatar === undefined || mediaOk(r.avatar))
    case 'friends':
      return Array.isArray(r.list) && r.list.length <= 5000 && r.list.every((x) => str(x, 32))
    case 'post':
      return (
        (r.kind === 'post' || r.kind === 'story') &&
        Array.isArray(r.media) &&
        r.media.length >= 1 &&
        r.media.length <= 10 &&
        r.media.every(mediaOk) &&
        str(r.caption, 2200) &&
        typeof r.aspect === 'number'
      )
    case 'like':
      return str(r.post, 64) && typeof r.on === 'boolean'
    case 'comment':
      return str(r.post, 64) && str(r.text, 1000) && r.text.trim().length > 0
    case 'del':
      return str(r.target, 64)
    default:
      return false
  }
}

/** All blob hashes a record depends on. */
export function blobRefs(rec: AnyRec): string[] {
  const out: string[] = []
  const add = (m?: MediaRef) => {
    if (!m) return
    out.push(m.hash)
    if (m.thumb) out.push(m.thumb)
  }
  if (rec.t === 'post') rec.media.forEach(add)
  if (rec.t === 'profile') add(rec.avatar)
  return out
}

export function isExpired(rec: AnyRec, now = Date.now()) {
  return rec.t === 'post' && rec.expiresAt !== undefined && rec.expiresAt <= now
}
