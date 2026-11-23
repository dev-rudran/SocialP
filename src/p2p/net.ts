import { getRelaySockets, joinRoom, type JoinRoomConfig, type JsonValue, type Room, type TurnServerConfig } from 'trystero'
import { on } from '../core/bus'
import { db, getSettings, putBlob, putRecord, touchBlob } from '../core/db'
import { pubMatchesId, signText, verifyText, type Identity } from '../core/identity'
import { verifyRecord, type MediaRef, type ProfileRec, type Stored } from '../core/records'
import { publishFriendList } from '../core/actions'
import { sha256Hex, toHex, utf8 } from '../lib/encoding'
import { sha256 } from '@noble/hashes/sha2.js'
import { peers } from '../state/peers'
import { relayServers } from './ice'
import { buildManifest, canServeBlob, missingFrom, selectRecords, shouldAccept, Visibility, type ManifestEntry } from './policy'

const APP_ID = 'socialp.p2p/v1'
const MAX_BLOB = 60 * 1024 * 1024

/**
 * Room topology
 *  - inbox:<me>          I always sit here; strangers who have my ID drop friend requests.
 *  - inbox:<them>        joined while my request to them is pending, to deliver it.
 *  - pair:<hash(a,b)>    one per friendship; all syncing happens here. Joining it signals acceptance.
 * Every room is password-protected with IDs only the participants know, and every peer must prove
 * ownership of its ID (Ed25519 challenge) before any data is exchanged.
 */
type Kind = 'inbox' | 'outbox' | 'pair'

interface Auth {
  by: string
  pub: string
  sig: string
}

interface Ctx {
  key: string
  kind: Kind
  /** the friend this room is about (outbox / pair) */
  target?: string
  room: Room
  roomId: string
  password: string
  /** joined with TURN servers */
  relay: boolean
  authed: Map<string, string> // peerId -> verified user id
  auth: ReturnType<typeof makeActions>['auth']
  friendReq: ReturnType<typeof makeActions>['friendReq']
  manifest: ReturnType<typeof makeActions>['manifest']
  records: ReturnType<typeof makeActions>['records']
  blob: ReturnType<typeof makeActions>['blob']
  push: ReturnType<typeof makeActions>['push']
}

function makeActions(room: Room) {
  return {
    auth: room.makeAction<{ nonce: string }, JsonValue>('auth', { kind: 'request' }),
    friendReq: room.makeAction<JsonValue>('freq'),
    manifest: room.makeAction<JsonValue, JsonValue>('manifest', { kind: 'request' }),
    records: room.makeAction<{ ids: string[] }, JsonValue>('records', { kind: 'request' }),
    blob: room.makeAction<{ hash: string }, Uint8Array>('blob', { kind: 'request' }),
    push: room.makeAction<JsonValue>('push'),
  }
}

const pairKey = (a: string, b: string) => [a, b].sort().join(':')
const authMsg = (roomKey: string, nonce: string) => `socialp-auth|${roomKey}|${nonce}`

class Network {
  private me: Identity | null = null
  private rooms = new Map<string, Ctx>()
  /** friend id -> where they're reachable */
  private live = new Map<string, { ctx: Ctx; peerId: string }>()
  private inflight = new Map<string, Promise<boolean>>()
  private wanted = new Map<string, { mime: string; owner: string }>()
  private prefetchQueue: { ref: MediaRef; owner: string }[] = []
  private prefetching = false
  private config: JoinRoomConfig = { appId: APP_ID }
  private policy: 'auto' | 'always' | 'never' = 'auto'
  private turn: TurnServerConfig[] = []
  /** rooms where a direct connection failed, so they now run through the relay */
  private relayKeys = new Set<string>()
  private unsubs: (() => void)[] = []
  private reconciling: Promise<void> | null = null
  private log: string[] = []
  private trace(msg: string) {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
    if (this.log.length > 200) this.log.shift()
  }

  async start(me: Identity) {
    if (this.me?.id === me.id) return
    await this.stop()
    this.me = me
    peers.setStatus('connecting')
    await this.loadConfig()
    this.unsubs.push(
      on('local', (rec) => void this.broadcast(rec)),
      on('friends', () => void this.reconcile()),
      on('network', () => void this.restart()),
    )
    await this.reconcile()
    peers.setStatus('online')
  }

  async stop() {
    this.unsubs.forEach((u) => u())
    this.unsubs = []
    await Promise.allSettled([...this.rooms.values()].map((c) => c.room.leave()))
    this.rooms.clear()
    this.live.clear()
    this.me = null
    peers.reset()
  }

  private async restart() {
    const me = this.me
    if (!me) return
    await this.stop()
    await this.start(me)
  }

  private async loadConfig() {
    const s = await getSettings()
    const cfg: JoinRoomConfig = { appId: APP_ID, identity: 'none', maxReceiveBytes: MAX_BLOB }
    if (s.relayUrls.length) cfg.relayConfig = { urls: s.relayUrls }
    this.config = cfg
    this.policy = s.relayPolicy
    this.relayKeys.clear()
    this.turn = []
    if (this.policy === 'always') {
      this.turn = await relayServers()
      peers.setRelay(this.turn.length ? 'active' : 'unavailable')
      if (!this.turn.length) this.trace('always-relay requested but no relay is available; connecting directly')
    }
  }

  private roomConfig(relay: boolean, password: string): JoinRoomConfig {
    if (!relay || !this.turn.length) return { ...this.config, password }
    return {
      ...this.config,
      password,
      turnConfig: this.turn,
      rtcConfig: this.policy === 'always' ? { iceTransportPolicy: 'relay' } : undefined,
    }
  }

  /** A direct connection in this room failed: rejoin it with TURN servers. */
  private async upgradeToRelay(key: string) {
    if (this.policy === 'never' || this.relayKeys.has(key)) return
    this.relayKeys.add(key)
    if (!this.turn.length) this.turn = await relayServers()
    if (!this.turn.length) {
      peers.setRelay('unavailable')
      this.trace(`${key}: direct connection failed and no relay is available`)
      return
    }
    peers.setRelay('active')
    const ctx = this.rooms.get(key)
    if (!ctx || ctx.relay) return
    this.trace(`${key}: direct connection failed, retrying through relay`)
    this.rooms.delete(key)
    this.dropLinks(ctx)
    await ctx.room.leave().catch(() => {})
    if (this.me && !this.rooms.has(key)) this.join(key, ctx.kind, ctx.roomId, ctx.password, ctx.target)
  }

  private dropLinks(ctx: Ctx) {
    for (const [who, link] of this.live) {
      if (link.ctx !== ctx) continue
      this.live.delete(who)
      peers.setOnline(who, false)
    }
  }

  /** Inspect the selected ICE candidate pair to tell whether a link is relayed. */
  private async detectLink(ctx: Ctx, peerId: string, who: string) {
    try {
      const pc = ctx.room.getPeers()[peerId]?.connection
      if (!pc) return
      const stats = await pc.getStats()
      let relayed = false
      stats.forEach((r) => {
        if (r.type !== 'candidate-pair' || !(r.nominated || r.selected) || r.state !== 'succeeded') return
        const local = stats.get(r.localCandidateId)
        const remote = stats.get(r.remoteCandidateId)
        if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') relayed = true
      })
      peers.setLink(who, relayed ? 'relay' : 'direct')
      this.trace(`link ${who.slice(0, 6)}: ${relayed ? 'relayed' : 'direct'}`)
    } catch {
      // stats are best-effort
    }
  }

  debugState() {
    return {
      policy: this.policy,
      relayServers: this.turn.length,
      signaling: Object.entries(getRelaySockets()).map(([url, ws]) => ({ url, open: ws.readyState === WebSocket.OPEN })),
      rooms: [...this.rooms.values()].map((c) => ({
        key: c.key.replace(/:(\w{6})\w+/, ':$1…'),
        relay: c.relay,
        peers: Object.keys(c.room.getPeers()).length,
        authed: [...c.authed.values()].map((id) => id.slice(0, 6)),
      })),
      live: [...this.live.keys()],
      wanted: this.wanted.size,
      log: this.log,
    }
  }

  isOnline(id: string) {
    return this.live.has(id)
  }

  // ---------------- room lifecycle ----------------

  /** Make the set of joined rooms match the friends table. */
  reconcile(): Promise<void> {
    const run = async () => {
      const me = this.me
      if (!me) return
      const friends = await db.friends.toArray()
      const want = new Map<string, { kind: Kind; roomId: string; password: string; target?: string }>()
      want.set(`inbox:${me.id}`, { kind: 'inbox', roomId: `inbox-${me.id}`, password: me.id })
      for (const f of friends) {
        if (f.status === 'incoming') continue
        const pk = pairKey(me.id, f.id)
        want.set(`pair:${f.id}`, { kind: 'pair', roomId: `pair-${toHex(sha256(utf8(pk))).slice(0, 40)}`, password: pk, target: f.id })
        if (f.status === 'outgoing') want.set(`outbox:${f.id}`, { kind: 'outbox', roomId: `inbox-${f.id}`, password: f.id, target: f.id })
      }
      for (const [key, ctx] of this.rooms) {
        if (want.has(key)) continue
        this.rooms.delete(key)
        if (ctx.kind === 'pair' && ctx.target && this.live.get(ctx.target)?.ctx === ctx) {
          this.live.delete(ctx.target)
          peers.setOnline(ctx.target, false)
        }
        void ctx.room.leave()
      }
      for (const [key, w] of want) if (!this.rooms.has(key)) this.join(key, w.kind, w.roomId, w.password, w.target)
    }
    this.reconciling = (this.reconciling ?? Promise.resolve()).then(run, run)
    return this.reconciling
  }

  private join(key: string, kind: Kind, roomId: string, password: string, target?: string) {
    const relay = this.turn.length > 0 && (this.policy === 'always' || this.relayKeys.has(key))
    const room = joinRoom(this.roomConfig(relay, password), roomId)
    const ctx: Ctx = { key, kind, target, room, roomId, password, relay, authed: new Map(), ...makeActions(room) }
    this.rooms.set(key, ctx)
    this.trace(`join ${key.slice(0, 13)}${relay ? ' (relay)' : ''}`)

    room.onError((e) => {
      this.trace(`${key.slice(0, 13)} error ${e.code}${'turnConfigured' in e ? ` turn=${e.turnConfigured}` : ''}`)
      if (e.code === 'relay-failed') peers.setStatus('online', 'Some signaling relays are unreachable')
      if (e.code === 'peer-connect-failed' && !ctx.relay) void this.upgradeToRelay(key)
    })

    ctx.auth.onRequest(({ nonce }) => {
      const me = this.me!
      return { by: me.id, pub: me.pub, sig: signText(authMsg(roomId, String(nonce)), me.secret) } satisfies Auth
    })

    room.onPeerJoin(async ({ peerId }) => {
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)))
      try {
        const res = (await ctx.auth.request({ nonce }, { target: peerId, timeoutMs: 20_000 })) as unknown as Auth
        if (!res || !pubMatchesId(res.pub, res.by) || !verifyText(res.sig, authMsg(roomId, nonce), res.pub)) return
        if (res.by === this.me?.id) return // our own other tab
        ctx.authed.set(peerId, res.by)
        this.trace(`authed ${key} peer=${peerId.slice(0, 6)} user=${res.by.slice(0, 6)}`)
        await this.onAuthed(ctx, peerId, res)
      } catch (err) {
        this.trace(`auth/onAuthed failed ${key}: ${err}`)
      }
    })

    room.onPeerLeave(({ peerId }) => {
      const who = ctx.authed.get(peerId)
      this.trace(`leave ${key} peer=${peerId.slice(0, 6)} user=${who?.slice(0, 6)}`)
      ctx.authed.delete(peerId)
      const link = who ? this.live.get(who) : undefined
      // peer ids are shared across rooms, so only the room that owns the link may tear it down
      if (who && link?.ctx === ctx && link.peerId === peerId) {
        this.live.delete(who)
        peers.setOnline(who, false)
        void db.friends.update(who, { lastSeen: Date.now() })
      }
    })

    // --- friend requests (only meaningful in my inbox) ---
    ctx.friendReq.onMessage(async (data, { peerId }) => {
      if (kind !== 'inbox') return
      const from = await waitFor(() => ctx.authed.get(peerId), 15_000)
      const rec = verifyRecord(data)
      if (!from || !rec || rec.t !== 'profile' || rec.by !== from) return
      const existing = await db.friends.get(from)
      await putRecord(rec)
      if (!existing) await db.friends.put({ id: from, pub: rec.pub, status: 'incoming', addedAt: Date.now() })
      else if (existing.status === 'outgoing') {
        // we both asked: that's mutual consent
        await db.friends.update(from, { status: 'accepted', pub: rec.pub })
        await publishFriendList()
        void this.reconcile()
      }
    })

    // --- sync handlers (pair rooms, accepted friends only) ---
    const friendOf = async (peerId: string) => {
      if (kind !== 'pair') return null
      const who = await waitFor(() => ctx.authed.get(peerId), 15_000)
      if (!who || who !== target) return null
      const f = await db.friends.get(who)
      if (f?.status === 'outgoing') await this.markAccepted(who) // they are in our pair room => they accepted
      else if (f?.status !== 'accepted') return null
      return who
    }

    ctx.manifest.onRequest(async (_d, { peerId }) => {
      const who = await friendOf(peerId)
      if (!who) throw new Error('forbidden')
      return (await buildManifest(this.me!.id, who)) as unknown as JsonValue
    })

    ctx.records.onRequest(async ({ ids }, { peerId }) => {
      const who = await friendOf(peerId)
      if (!who || !Array.isArray(ids)) throw new Error('forbidden')
      return (await selectRecords(this.me!.id, who, ids)) as unknown as JsonValue
    })

    ctx.blob.onRequest(async ({ hash }, { peerId }) => {
      const who = await friendOf(peerId)
      if (!who || typeof hash !== 'string') throw new Error('forbidden')
      if (!(await canServeBlob(this.me!.id, who, hash))) return new Uint8Array(0)
      const row = await db.blobs.get(hash)
      if (row) void touchBlob(hash) // serving it to friends counts as use
      return row ? new Uint8Array(await row.data.arrayBuffer()) : new Uint8Array(0)
    })

    ctx.push.onMessage(async (data, { peerId }) => {
      if (!(await friendOf(peerId))) return
      if (Array.isArray(data)) await this.ingest(data)
    })
  }

  private async onAuthed(ctx: Ctx, peerId: string, who: Auth) {
    const me = this.me!
    if (ctx.kind === 'outbox' && who.by === ctx.target) {
      const profile = await db.records.get(`profile:${me.id}`)
      if (profile) await ctx.friendReq.send(profile as unknown as JsonValue, { target: peerId })
      return
    }
    if (ctx.kind !== 'pair' || who.by !== ctx.target) return
    const f = await db.friends.get(who.by)
    this.trace(`onAuthed pair status=${f?.status}`)
    if (!f) return
    if (f.status === 'outgoing') await this.markAccepted(who.by)
    if (!f.pub) await db.friends.update(who.by, { pub: who.pub })
    this.live.set(who.by, { ctx, peerId })
    this.trace(`live ${who.by.slice(0, 6)}`)
    void this.detectLink(ctx, peerId, who.by)
    peers.setOnline(who.by, true)
    await db.friends.update(who.by, { lastSeen: Date.now() })
    await this.pull(ctx, peerId)
    this.retryWanted()
  }

  private async markAccepted(id: string) {
    const f = await db.friends.get(id)
    if (f?.status !== 'outgoing') return
    await db.friends.update(id, { status: 'accepted' })
    await publishFriendList()
    void this.reconcile() // drops the outbox room
  }

  // ---------------- sync ----------------

  private async pull(ctx: Ctx, peerId: string) {
    try {
      const entries = (await ctx.manifest.request({}, { target: peerId, timeoutMs: 30_000 })) as unknown as ManifestEntry[]
      if (!Array.isArray(entries)) return
      const missing = await missingFrom(entries)
      for (let i = 0; i < missing.length; i += 200) {
        const recs = await ctx.records.request({ ids: missing.slice(i, i + 200) }, { target: peerId, timeoutMs: 30_000 })
        if (Array.isArray(recs)) await this.ingest(recs)
      }
    } catch (err) {
      console.debug('[p2p] pull failed', err)
    }
  }

  private async ingest(items: unknown[]) {
    const me = this.me!
    // friend lists first so later visibility checks see them; then posts before likes/comments
    const order = { friends: 0, profile: 1, post: 2, del: 3, like: 4, comment: 5 } as Record<string, number>
    const recs = items.map(verifyRecord).filter((r): r is Stored => !!r)
    recs.sort((a, b) => order[a.t] - order[b.t])
    for (const rec of recs) {
      if (!(await shouldAccept(me.id, rec))) continue
      if (await putRecord(rec)) {
        for (const ref of mediaOf(rec)) this.enqueuePrefetch(ref, rec.by)
      }
    }
  }

  /** Push a freshly authored record to every online friend allowed to see it. */
  private async broadcast(rec: Stored) {
    const vis = new Visibility(this.me!.id)
    for (const [friendId, { ctx, peerId }] of this.live) {
      if (await vis.canSee(friendId, rec)) void ctx.push.send([rec] as unknown as JsonValue, { target: peerId }).catch(() => {})
    }
  }

  // ---------------- blobs ----------------

  /** Fetch a blob from whoever is online, preferring its owner. Resolves true once stored locally. */
  fetchBlob(hash: string, mime: string, owner: string): Promise<boolean> {
    const existing = this.inflight.get(hash)
    if (existing) return existing
    const p = (async () => {
      if (await db.blobs.get(hash)) return true
      const candidates = [...this.live.entries()].sort(([a], [b]) => (a === owner ? -1 : b === owner ? 1 : 0))
      for (const [, { ctx, peerId }] of candidates) {
        try {
          peers.setProgress(hash, 0)
          const bytes = await ctx.blob.request(
            { hash },
            { target: peerId, timeoutMs: 180_000, onProgress: (pct) => peers.setProgress(hash, pct) },
          )
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) continue
          if ((await sha256Hex(bytes)) !== hash) continue // tampered or corrupt
          await putBlob(hash, new Blob([bytes as BlobPart], { type: mime }), mime)
          this.wanted.delete(hash)
          return true
        } catch {
          // try next peer
        } finally {
          peers.setProgress(hash, null)
        }
      }
      this.wanted.set(hash, { mime, owner })
      return false
    })().finally(() => this.inflight.delete(hash))
    this.inflight.set(hash, p)
    return p
  }

  private retryWanted() {
    for (const [hash, { mime, owner }] of this.wanted) void this.fetchBlob(hash, mime, owner)
    void this.drainPrefetch()
  }

  /** Background-download friends' media so we can re-seed it while they're offline. Thumbs first. */
  private enqueuePrefetch(ref: MediaRef, owner: string) {
    if (ref.thumb) this.prefetchQueue.unshift({ ref: { ...ref, hash: ref.thumb, mime: 'image/jpeg' }, owner })
    this.prefetchQueue.push({ ref, owner })
    void this.drainPrefetch()
  }

  private async drainPrefetch() {
    if (this.prefetching) return
    this.prefetching = true
    try {
      while (this.prefetchQueue.length && this.live.size) {
        const { ref, owner } = this.prefetchQueue.shift()!
        await this.fetchBlob(ref.hash, ref.mime, owner)
      }
    } finally {
      this.prefetching = false
    }
  }
}

async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 250))
  }
}

function mediaOf(rec: Stored): MediaRef[] {
  if (rec.t === 'post') return rec.media
  if (rec.t === 'profile' && (rec as ProfileRec).avatar) return [(rec as ProfileRec).avatar!]
  return []
}

export const net = new Network()

if (import.meta.env.DEV)
  Object.assign(globalThis, {
    __socialp: { net, debug: () => net.debugState(), simulateDirectFailure: (key: string) => (net as unknown as { upgradeToRelay(k: string): Promise<void> }).upgradeToRelay(key) },
  })
