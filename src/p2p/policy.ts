import { db } from '../core/db'
import { blobRefs, isReplaceable, type FriendListRec, type Stored } from '../core/records'

/**
 * Who may receive which record. Rule: a record belongs to an "owner" (the author of the post it hangs off).
 * A requester may see it if they are the owner, or the owner's latest signed friend list includes them.
 * That lets friends re-seed each other's posts without ever leaking them beyond the owner's circle.
 */
export class Visibility {
  private lists = new Map<string, Set<string> | null>()
  private posts = new Map<string, Stored | null>()
  private myId: string
  constructor(myId: string) {
    this.myId = myId
  }

  private async friendsOf(owner: string): Promise<Set<string> | null> {
    if (!this.lists.has(owner)) {
      const rec = (await db.records.get(`friends:${owner}`)) as Stored<FriendListRec> | undefined
      this.lists.set(owner, rec ? new Set(rec.list) : null)
    }
    return this.lists.get(owner)!
  }

  private async post(id: string) {
    if (!this.posts.has(id)) this.posts.set(id, (await db.records.get(id)) ?? null)
    return this.posts.get(id)!
  }

  /** Assumes `requester` is already an authenticated, accepted friend of mine. */
  async canSee(requester: string, rec: Stored): Promise<boolean> {
    // Profiles (name, bio, avatar) are shown to friends-of-friends so comment authors render with a name.
    if (rec.t === 'profile') return true
    let owner = rec.by
    if (rec.t === 'like' || rec.t === 'comment') {
      const p = await this.post(rec.post)
      if (!p) return false
      owner = p.by
    }
    if (owner === requester || owner === this.myId) return true
    return (await this.friendsOf(owner))?.has(requester) ?? false
  }
}

export interface ManifestEntry {
  id: string
  ts: number
}

export async function buildManifest(myId: string, requester: string): Promise<ManifestEntry[]> {
  const vis = new Visibility(myId)
  const out: ManifestEntry[] = []
  const now = Date.now()
  for (const r of await db.records.toArray()) {
    if (r.t === 'post' && r.expiresAt && r.expiresAt <= now) continue
    if (await vis.canSee(requester, r)) out.push({ id: r.id, ts: r.ts })
  }
  return out
}

export async function selectRecords(myId: string, requester: string, ids: string[]): Promise<Stored[]> {
  const vis = new Visibility(myId)
  const recs = (await db.records.bulkGet(ids.slice(0, 500))).filter((r): r is Stored => !!r)
  const out: Stored[] = []
  for (const r of recs) if (await vis.canSee(requester, r)) out.push(r)
  return out
}

/** Which manifest entries we don't have yet (or have an older version of). */
export async function missingFrom(entries: ManifestEntry[]): Promise<string[]> {
  const local = await db.records.bulkGet(entries.map((e) => e.id))
  const missing: string[] = []
  entries.forEach((e, i) => {
    const have = local[i]
    if (!have) missing.push(e.id)
    else if (isReplaceable(have.t) && have.ts < e.ts) missing.push(e.id)
  })
  return missing
}

export async function canServeBlob(myId: string, requester: string, hash: string): Promise<boolean> {
  const vis = new Visibility(myId)
  for (const r of await db.records.where('t').anyOf('post', 'profile').toArray()) {
    if (blobRefs(r).includes(hash) && (await vis.canSee(requester, r))) return true
  }
  return false
}

/** Whether to store a verified record pushed to us by `from` (an accepted friend). */
export async function shouldAccept(myId: string, rec: Stored): Promise<boolean> {
  if (rec.by === myId) return true // our own data coming back (e.g. restoring on a new device)
  const author = await db.friends.get(rec.by)
  const isFriend = author?.status === 'accepted'
  switch (rec.t) {
    case 'post':
    case 'friends':
    case 'del':
      return isFriend
    case 'profile':
    case 'like':
    case 'comment':
      return true // commenters may be friends-of-friends; we still need their name
    default:
      return false
  }
}
