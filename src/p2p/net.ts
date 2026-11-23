import { getRelaySockets, joinRoom, type JoinRoomConfig, type JsonValue, type Room, type TurnServerConfig } from 'trystero'
import { on } from '../core/bus'
import { db, getSettings, putBlob, putRecord, touchBlob } from '../core/db'
import { pubMatchesId, signText, verifyText, type Identity } from '../core/identity'
import { verifyRecord, type FriendListRec, type MediaRef, type ProfileRec, type Stored } from '../core/records'
import { publishFriendList } from '../core/actions'
import { fromB64, sha256Hex, toB64, toHex, utf8 } from '../lib/encoding'
import { sha256 } from '@noble/hashes/sha2.js'
import { peers } from '../state/peers'
import { relayServers, relayIsTrusted } from './ice'
import { DirectLink, MeshLink, type Link, type Op } from './links'
import { probeNat, type NatInfo } from './nat'
import { buildManifest, canServeBlob, missingFrom, selectRecords, shouldAccept, Visibility, type ManifestEntry } from './policy'
import { MeshSession, type Hello, type Sealed } from './seal'

const APP_ID = 'socialp.p2p/v1'
const DEV_FLAGS = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
/** dev-only: ?nodirect makes direct attempts gather no candidates, simulating a carrier NAT */
const SIMULATE_NO_DIRECT = !!DEV_FLAGS?.has('nodirect')
const MAX_BLOB = 60 * 1024 * 1024
const MESH_CHUNK = 192 * 1024
/** per sender→recipient forwarding budget, per 10 s window */
const FWD_BUDGET_BYTES = 40 * 1024 * 1024

/**
 * Room topology
 *  - inbox:<me>          I always sit here; strangers who have my ID drop friend requests.
 *  - inbox:<them>        joined while my request to them is pending, to deliver it.
 *  - pair:<hash(a,b)>    one per friendship; all syncing happens here. Joining it signals acceptance.
 * Every room is password-protected with IDs only the participants know, and every peer must prove
 * ownership of its ID (Ed25519 challenge) before any data is exchanged.
 *
 * Reaching a friend, in order of preference:
 *  1. direct WebRTC in our pair room (with TURN offered when it's our own relay or the NAT needs it)
 *  2. mesh: a mutual friend connected to both of us forwards end-to-end encrypted frames
 *  3. TURN relay fallback when direct attempts fail
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
  actions: ReturnType<typeof makeActions>
}

function makeActions(room: Room) {
  return {
    auth: room.makeAction<{ nonce: string }, JsonValue>('auth', { kind: 'request' }),
    friendReq: room.makeAction<JsonValue>('freq'),
    manifest: room.makeAction<JsonValue, JsonValue>('manifest', { kind: 'request' }),
    records: room.makeAction<{ ids: string[] }, JsonValue>('records', { kind: 'request' }),
    blob: room.makeAction<{ hash: string }, Uint8Array>('blob', { kind: 'request' }),
    push: room.makeAction<JsonValue>('push'),
    /** which of the recipient's friends I'm directly connected to */
    presence: room.makeAction<JsonValue>('presence'),
    /** mesh frames: { to, frame } to the forwarder, { from, frame } from the forwarder */
    fwd: room.makeAction<JsonValue>('fwd'),
  }
}

interface MeshState {
  session: MeshSession
  via: string
  link: MeshLink | null
  /** sealing and opening must happen in counter order */
  sendChain: Promise<void>
  recvChain: Promise<void>
  helloSentFor: string | null
  started: number
}

const pairKey = (a: string, b: string) => [a, b].sort().join(':')
const authMsg = (roomKey: string, nonce: string) => `socialp-auth|${roomKey}|${nonce}`

class Network {
  private me: Identity | null = null
  private rooms = new Map<string, Ctx>()
  /** friend id -> best current link */
  private live = new Map<string, Link>()
  /** friend id -> direct link, kept even while a mesh link is primary */
  private direct = new Map<string, DirectLink>()
  /** mutual friend M -> friends M says it can reach directly */
  private reach = new Map<string, Set<string>>()
  private mesh = new Map<string, MeshState>()
  private fwdUsage = new Map<string, { at: number; bytes: number }>()
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private blockedDirect = new Set<string>()
  private inflight = new Map<string, Promise<boolean>>()
  private wanted = new Map<string, { mime: string; owner: string }>()
  private prefetchQueue: { ref: MediaRef; owner: string }[] = []
  private prefetching = false
  private config: JoinRoomConfig = { appId: APP_ID }
  private policy: 'auto' | 'always' | 'never' = 'auto'
  private turn: TurnServerConfig[] = []
  /** rooms where a direct connection failed, so they now run through the relay */
  private relayKeys = new Set<string>()
  /** join every room with the relay offered (own relay, or a NAT that can't do direct) */
  private preferRelay = false
  private nat: NatInfo = { type: 'unknown', ipv6: false }
  /** consecutive failed attempts per room, for backoff */
  private failures = new Map<string, number>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private unsubs: (() => void)[] = []
  private reconciling: Promise<void> | null = null
  private log: string[] = []
  private trace(msg: string) {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
    if (this.log.length > 300) this.log.shift()
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
    this.retryTimers.forEach(clearTimeout)
    this.retryTimers.clear()
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    this.unsubs.forEach((u) => u())
    this.unsubs = []
    for (const m of this.mesh.values()) m.link?.close()
    await Promise.allSettled([...this.rooms.values()].map((c) => c.room.leave()))
    this.rooms.clear()
    this.live.clear()
    this.direct.clear()
    this.mesh.clear()
    this.reach.clear()
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
    this.failures.clear()
    this.retryTimers.forEach(clearTimeout)
    this.retryTimers.clear()
    this.turn = []
    this.preferRelay = false
    this.nat = await probeNat()
    peers.setNat(this.nat)
    this.trace(`nat ${this.nat.type}${this.nat.ipv6 ? ' +ipv6' : ''}`)
    if (this.policy === 'never') return
    // Offer the relay from the start when it's our own (ICE still picks direct whenever it works), or when this
    // network can't do direct anyway — instead of waiting ~30 s for every direct attempt to fail.
    const badNat = this.nat.type === 'symmetric' || this.nat.type === 'blocked'
    // a TURN server the user entered themselves is trusted too: they chose it
    if (this.policy === 'always' || relayIsTrusted() || !!s.turnUrl || badNat) {
      this.turn = await relayServers()
      this.preferRelay = this.turn.length > 0
      if (this.policy === 'always' || badNat) peers.setRelay(this.turn.length ? 'active' : 'unavailable')
      if (!this.turn.length && (this.policy === 'always' || badNat)) this.trace('relay wanted but none is available; connecting directly')
    }
  }

  private roomConfig(relay: boolean, password: string): JoinRoomConfig {
    if (SIMULATE_NO_DIRECT && (!relay || !this.turn.length)) return { ...this.config, password, rtcConfig: { iceTransportPolicy: 'relay', iceServers: [] } }
    if (!relay || !this.turn.length) return { ...this.config, password }
    return {
      ...this.config,
      password,
      turnConfig: this.turn,
      rtcConfig: this.policy === 'always' ? { iceTransportPolicy: 'relay' } : undefined,
    }
  }

  /**
   * A connection attempt in this room failed. First failure: switch the room to the relay. Later failures
   * (including relayed ones): rejoin with jittered exponential backoff — never give up while the room is wanted.
   */
  private async onConnectFailed(key: string) {
    if (this.retryTimers.has(key)) return
    const n = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, n)
    const ctx = this.rooms.get(key)
    // a mesh link to this friend already works: no need to burn relay bandwidth on the pair room
    const meshCovers = ctx?.kind === 'pair' && !!ctx.target && this.live.get(ctx.target)?.kind === 'mesh'
    if (this.policy !== 'never' && !this.relayKeys.has(key) && !meshCovers) {
      this.relayKeys.add(key)
      if (!this.turn.length) this.turn = await relayServers()
      peers.setRelay(this.turn.length ? 'active' : 'unavailable')
      this.trace(`${key.slice(0, 13)}: direct failed${this.turn.length ? ', switching to relay' : ' and no relay is available'}`)
    }
    // Avoid both sides leaving/rejoining at the same instant: one side leads, the other follows a few seconds later.
    const leads = ctx?.kind === 'outbox' || (ctx?.kind === 'pair' && !!ctx.target && this.me!.id < ctx.target)
    const base = n === 1 ? (leads ? 300 : 4000) : Math.min(60_000, 2000 * 2 ** (n - 2))
    const delay = base * (0.75 + Math.random() / 2)
    this.trace(`${key.slice(0, 13)}: retry #${n} in ${(delay / 1000).toFixed(1)}s`)
    this.retryTimers.set(
      key,
      setTimeout(() => {
        this.retryTimers.delete(key)
        void this.rejoin(key)
      }, delay),
    )
  }

  private async rejoin(key: string) {
    const ctx = this.rooms.get(key)
    if (!ctx || !this.me) return
    if (ctx.authed.size > 0) return // connected in the meantime
    this.rooms.delete(key)
    this.dropDirect(ctx)
    await ctx.room.leave().catch(() => {})
    if (this.me && !this.rooms.has(key)) this.join(key, ctx.kind, ctx.roomId, ctx.password, ctx.target)
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
      if (this.live.get(who)?.kind === 'direct') peers.setLink(who, relayed ? 'relay' : 'direct')
      this.trace(`link ${who.slice(0, 6)}: ${relayed ? 'relayed' : 'direct'}`)
    } catch {
      // stats are best-effort
    }
  }

  debugState() {
    return {
      policy: this.policy,
      nat: this.nat,
      preferRelay: this.preferRelay,
      relayServers: this.turn.length,
      signaling: Object.entries(getRelaySockets()).map(([url, ws]) => ({ url, open: ws.readyState === WebSocket.OPEN })),
      rooms: [...this.rooms.values()].map((c) => ({
        key: c.key.replace(/:(\w{6})\w+/, ':$1…'),
        relay: c.relay,
        peers: Object.keys(c.room.getPeers()).length,
        authed: [...c.authed.values()].map((id) => id.slice(0, 6)),
      })),
      live: [...this.live.values()].map((l) => `${l.friend.slice(0, 6)}:${l.kind}${l.via ? `@${l.via.slice(0, 6)}` : ''}`),
      reach: [...this.reach].map(([m, s]) => `${m.slice(0, 6)}→${[...s].map((x) => x.slice(0, 6)).join(',')}`),
      wanted: this.wanted.size,
      log: this.log,
    }
  }

  isOnline(id: string) {
    return this.live.has(id)
  }

  /** dev-only: pretend direct connections to this friend are impossible (to exercise the mesh path) */
  blockDirect(id: string) {
    this.blockedDirect.add(id)
    void this.reconcile()
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
        if (!this.blockedDirect.has(f.id))
          want.set(`pair:${f.id}`, { kind: 'pair', roomId: `pair-${toHex(sha256(utf8(pk))).slice(0, 40)}`, password: pk, target: f.id })
        if (f.status === 'outgoing') want.set(`outbox:${f.id}`, { kind: 'outbox', roomId: `inbox-${f.id}`, password: f.id, target: f.id })
      }
      for (const [key, ctx] of this.rooms) {
        if (want.has(key)) continue
        this.rooms.delete(key)
        this.dropDirect(ctx)
        void ctx.room.leave()
      }
      for (const [key, w] of want) if (!this.rooms.has(key)) this.join(key, w.kind, w.roomId, w.password, w.target)
      // friends removed: drop their mesh sessions
      const accepted = new Set(friends.filter((f) => f.status === 'accepted').map((f) => f.id))
      for (const id of this.mesh.keys()) if (!accepted.has(id)) this.dropMesh(id)
      this.considerMesh()
    }
    this.reconciling = (this.reconciling ?? Promise.resolve()).then(run, run)
    return this.reconciling
  }

  private join(key: string, kind: Kind, roomId: string, password: string, target?: string) {
    const relay = this.turn.length > 0 && (this.policy === 'always' || this.preferRelay || this.relayKeys.has(key))
    const room = joinRoom(this.roomConfig(relay, password), roomId)
    const ctx: Ctx = { key, kind, target, room, roomId, password, relay, authed: new Map(), actions: makeActions(room) }
    const a = ctx.actions
    this.rooms.set(key, ctx)
    this.trace(`join ${key.slice(0, 13)}${relay ? ' (relay)' : ''}`)

    room.onError((e) => {
      this.trace(`${key.slice(0, 13)} error ${e.code}${'turnConfigured' in e ? ` turn=${e.turnConfigured}` : ''}`)
      if (e.code === 'relay-failed') peers.setStatus('online', 'Some signaling relays are unreachable')
      if (e.code === 'peer-connect-failed' && this.rooms.get(key) === ctx) void this.onConnectFailed(key)
    })

    a.auth.onRequest(({ nonce }) => {
      const me = this.me!
      return { by: me.id, pub: me.pub, sig: signText(authMsg(roomId, String(nonce)), me.secret) } satisfies Auth
    })

    room.onPeerJoin(async ({ peerId }) => {
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)))
      try {
        const res = (await a.auth.request({ nonce }, { target: peerId, timeoutMs: 20_000 })) as unknown as Auth
        if (!res || !pubMatchesId(res.pub, res.by) || !verifyText(res.sig, authMsg(roomId, nonce), res.pub)) return
        if (res.by === this.me?.id) return // our own other tab
        ctx.authed.set(peerId, res.by)
        this.failures.delete(key)
        this.trace(`authed ${key.slice(0, 13)} peer=${peerId.slice(0, 6)} user=${res.by.slice(0, 6)}`)
        await this.onAuthed(ctx, peerId, res)
      } catch (err) {
        this.trace(`auth/onAuthed failed ${key.slice(0, 13)}: ${err}`)
      }
    })

    room.onPeerLeave(({ peerId }) => {
      const who = ctx.authed.get(peerId)
      this.trace(`leave ${key.slice(0, 13)} peer=${peerId.slice(0, 6)} user=${who?.slice(0, 6)}`)
      ctx.authed.delete(peerId)
      const link = who ? this.direct.get(who) : undefined
      // peer ids are shared across rooms, so only the room that owns the link may tear it down
      if (who && link?.owner === ctx && link.peerId === peerId) this.removeDirect(who)
    })

    // --- friend requests (only meaningful in my inbox) ---
    a.friendReq.onMessage(async (data, { peerId }) => {
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
    const serveVia = (op: Op) => async (data: unknown, { peerId }: { peerId: string }) => {
      const who = await friendOf(peerId)
      if (!who) throw new Error('forbidden')
      return this.serve(op, data, who)
    }
    a.manifest.onRequest(serveVia('manifest') as never)
    a.records.onRequest(serveVia('records') as never)
    a.blob.onRequest(serveVia('blob') as never)

    a.push.onMessage(async (data, { peerId }) => {
      if (!(await friendOf(peerId))) return
      if (Array.isArray(data)) await this.ingest(data)
    })

    a.presence.onMessage(async (data, { peerId }) => {
      const who = await friendOf(peerId)
      if (!who || !Array.isArray(data)) return
      const accepted = new Set((await db.friends.where('status').equals('accepted').primaryKeys()) as string[])
      this.reach.set(who, new Set((data as string[]).filter((id) => typeof id === 'string' && accepted.has(id) && id !== this.me?.id)))
      this.considerMesh()
    })

    a.fwd.onMessage(async (data, { peerId }) => {
      const who = await friendOf(peerId)
      if (!who || !data || typeof data !== 'object') return
      const msg = data as { to?: string; from?: string; frame?: Hello | Sealed }
      if (msg.to && msg.frame) await this.forward(who, msg.to, msg.frame)
      else if (msg.from && msg.frame) await this.onMeshFrame(msg.from, who, msg.frame)
    })
  }

  private async onAuthed(ctx: Ctx, peerId: string, who: Auth) {
    const me = this.me!
    if (ctx.kind === 'outbox' && who.by === ctx.target) {
      const profile = await db.records.get(`profile:${me.id}`)
      if (profile) await ctx.actions.friendReq.send(profile as unknown as JsonValue, { target: peerId })
      return
    }
    if (ctx.kind !== 'pair' || who.by !== ctx.target) return
    const f = await db.friends.get(who.by)
    if (!f) return
    if (f.status === 'outgoing') await this.markAccepted(who.by)
    if (!f.pub) await db.friends.update(who.by, { pub: who.pub })
    const link = new DirectLink(who.by, peerId, ctx, ctx.actions)
    this.direct.set(who.by, link)
    // direct beats mesh
    if (this.mesh.has(who.by)) this.dropMesh(who.by, false)
    await this.linkUp(link)
    void this.detectLink(ctx, peerId, who.by)
    this.schedulePresence()
  }

  /** A new primary link to a friend is ready: mark online and sync. */
  private async linkUp(link: Link) {
    this.live.set(link.friend, link)
    this.trace(`live ${link.friend.slice(0, 6)} ${link.kind}${link.via ? ` via ${link.via.slice(0, 6)}` : ''}`)
    peers.setOnline(link.friend, true)
    if (link.kind === 'mesh') peers.setLink(link.friend, `via:${link.via}`)
    await db.friends.update(link.friend, { lastSeen: Date.now() })
    await this.pull(link)
    this.retryWanted()
  }

  private removeDirect(who: string) {
    this.direct.delete(who)
    this.reach.delete(who) // they can no longer forward for us
    if (this.live.get(who)?.kind === 'direct') {
      this.live.delete(who)
      peers.setOnline(who, false)
      void db.friends.update(who, { lastSeen: Date.now() })
    }
    // mesh sessions that were forwarded by them are gone too
    for (const [id, m] of this.mesh) if (m.via === who) this.dropMesh(id)
    this.schedulePresence()
    this.considerMesh()
  }

  private dropDirect(ctx: Ctx) {
    for (const [who, link] of this.direct) if (link.owner === ctx) this.removeDirect(who)
  }

  private async markAccepted(id: string) {
    const f = await db.friends.get(id)
    if (f?.status !== 'outgoing') return
    await db.friends.update(id, { status: 'accepted' })
    await publishFriendList()
    void this.reconcile() // drops the outbox room
  }

  // ---------------- serving (shared by every link type) ----------------

  private async serve(op: Op, data: unknown, who: string): Promise<unknown> {
    const me = this.me!.id
    const d = (data ?? {}) as { ids?: unknown; hash?: unknown; offset?: unknown; len?: unknown }
    switch (op) {
      case 'manifest':
        return buildManifest(me, who)
      case 'records':
        if (!Array.isArray(d.ids)) throw new Error('bad request')
        return selectRecords(me, who, d.ids as string[])
      case 'blob': {
        if (typeof d.hash !== 'string' || !(await canServeBlob(me, who, d.hash))) return new Uint8Array(0)
        const row = await db.blobs.get(d.hash)
        if (row) void touchBlob(d.hash) // serving it to friends counts as use
        return row ? new Uint8Array(await row.data.arrayBuffer()) : new Uint8Array(0)
      }
      case 'blobRange': {
        if (typeof d.hash !== 'string' || typeof d.offset !== 'number' || !(await canServeBlob(me, who, d.hash))) return { size: 0 }
        const row = await db.blobs.get(d.hash)
        if (!row) return { size: 0 }
        if (d.offset === 0) void touchBlob(d.hash)
        const len = Math.min(MESH_CHUNK, typeof d.len === 'number' ? d.len : MESH_CHUNK)
        const bytes = new Uint8Array(await row.data.slice(d.offset, d.offset + len).arrayBuffer())
        return { size: row.size, b64: toB64(bytes) }
      }
    }
  }

  // ---------------- mesh: mutual friends relay for each other ----------------

  /** Tell each directly connected friend M which of M's friends I can reach directly (mutual friends only). */
  private schedulePresence() {
    if (this.presenceTimer) return
    this.presenceTimer = setTimeout(async () => {
      this.presenceTimer = null
      for (const [m, link] of this.direct) {
        const list = (await db.records.get(`friends:${m}`)) as Stored<FriendListRec> | undefined
        const theirs = new Set(list?.list ?? [])
        const reachable = [...this.direct.keys()].filter((id) => id !== m && theirs.has(id))
        void (link.owner as Ctx).actions.presence.send(reachable, { target: link.peerId }).catch(() => {})
      }
    }, 800)
  }

  /** Start / stop mesh sessions so every accepted friend without a direct link uses a mutual friend if possible. */
  private considerMesh() {
    if (!this.me) return
    const routes = new Map<string, string>()
    for (const [m, reachable] of this.reach) {
      if (!this.direct.has(m)) continue
      for (const f of reachable) if (!routes.has(f) && !this.direct.has(f)) routes.set(f, m)
    }
    for (const [f, state] of this.mesh) {
      if (this.direct.has(f)) this.dropMesh(f, false) // direct beats mesh
      else if (this.direct.has(state.via)) continue // forwarder still connected
      else if (routes.has(f)) state.via = routes.get(f)! // reroute; the session is end-to-end, so keys stay valid
      else this.dropMesh(f)
    }
    for (const [f, via] of routes) if (!this.mesh.has(f)) void this.startMesh(f, via)
  }

  private async startMesh(friend: string, via: string) {
    const state: MeshState = {
      session: new MeshSession(this.me!, friend),
      via,
      link: null,
      sendChain: Promise.resolve(),
      recvChain: Promise.resolve(),
      helloSentFor: null,
      started: Date.now(),
    }
    this.mesh.set(friend, state)
    this.trace(`mesh ${friend.slice(0, 6)}: handshake via ${via.slice(0, 6)}`)
    this.sendFrame(friend, state, state.session.hello())
    try {
      await state.session.waitReady(20_000)
    } catch {
      if (this.mesh.get(friend) === state && !state.session.established) {
        this.trace(`mesh ${friend.slice(0, 6)}: handshake timed out`)
        this.mesh.delete(friend)
      }
    }
  }

  private dropMesh(friend: string, markOffline = true) {
    const state = this.mesh.get(friend)
    if (!state) return
    this.mesh.delete(friend)
    state.link?.close()
    if (this.live.get(friend) === state.link && state.link) {
      this.live.delete(friend)
      if (markOffline) peers.setOnline(friend, false)
    }
    this.trace(`mesh ${friend.slice(0, 6)}: closed`)
  }

  private sendFrame(friend: string, state: MeshState, frame: Hello | Sealed) {
    const hop = this.direct.get(state.via)
    if (!hop) return Promise.reject(new Error('mesh route lost'))
    return (hop.owner as Ctx).actions.fwd.send({ to: friend, frame } as unknown as JsonValue, { target: hop.peerId })
  }

  private sealAndSend(friend: string, state: MeshState, payload: unknown): Promise<void> {
    const next = state.sendChain.then(async () => {
      const frame = await state.session.seal(payload)
      await this.sendFrame(friend, state, frame)
    })
    state.sendChain = next.catch(() => {})
    return next
  }

  /** I'm the mutual friend in the middle: forward a frame, but only between two people who are friends. */
  private async forward(from: string, to: string, frame: Hello | Sealed) {
    const hop = this.direct.get(to)
    if (!hop || to === from) return
    const list = (await db.records.get(`friends:${to}`)) as Stored<FriendListRec> | undefined
    if (!list?.list.includes(from)) {
      this.trace(`fwd refused ${from.slice(0, 6)}→${to.slice(0, 6)}: not friends`)
      return
    }
    const key = `${from}>${to}`
    const now = Date.now()
    const size = JSON.stringify(frame).length
    const u = this.fwdUsage.get(key)
    const usage = u && now - u.at < 10_000 ? u : { at: now, bytes: 0 }
    usage.bytes += size
    this.fwdUsage.set(key, usage)
    if (usage.bytes > FWD_BUDGET_BYTES) return // rate limit; the sender will retry
    if (frame.t === 'hello') this.trace(`forwarding for ${from.slice(0, 6)}→${to.slice(0, 6)} (encrypted)`)
    void (hop.owner as Ctx).actions.fwd.send({ from, frame } as unknown as JsonValue, { target: hop.peerId }).catch(() => {})
  }

  /** A frame from `from`, forwarded by mutual friend `via`. */
  private async onMeshFrame(from: string, via: string, frame: Hello | Sealed) {
    const f = await db.friends.get(from)
    if (f?.status !== 'accepted' || this.direct.has(from)) return
    let state = this.mesh.get(from)
    if (frame.t === 'hello') {
      if (!state) {
        state = { session: new MeshSession(this.me!, from), via, link: null, sendChain: Promise.resolve(), recvChain: Promise.resolve(), helloSentFor: null, started: Date.now() }
        this.mesh.set(from, state)
      }
      const s = state
      if (!(await s.session.accept(frame))) return this.trace(`mesh ${from.slice(0, 6)}: bad hello`)
      s.via = via
      // answer each new peer key once, so restarts on either side re-handshake without ping-pong
      if (s.helloSentFor !== frame.eph) {
        s.helloSentFor = frame.eph
        void this.sendFrame(from, s, s.session.hello()).catch(() => {})
      }
      if (!s.link) {
        s.link = new MeshLink(from, via, (payload) => this.sealAndSend(from, s, payload))
        if (!this.direct.has(from)) await this.linkUp(s.link)
      }
      return
    }
    if (!state?.session.established || frame.t !== 'data') return
    const s = state
    s.recvChain = s.recvChain.then(async () => {
      let msg: { k: string; id?: number; op?: Op; data?: unknown; ok?: boolean }
      try {
        msg = (await s.session.open(frame)) as typeof msg
      } catch (e) {
        return this.trace(`mesh ${from.slice(0, 6)}: dropped frame (${(e as Error).message})`)
      }
      if (msg.k === 'req' && msg.op && msg.id !== undefined) {
        let ok = true
        let data: unknown
        try {
          if (msg.op === 'blob') throw new Error('use blobRange over mesh')
          data = await this.serve(msg.op, msg.data, from)
          if (msg.op !== 'blobRange' || (msg.data as { offset?: number })?.offset === 0) this.trace(`mesh served ${msg.op} to ${from.slice(0, 6)}`)
        } catch (e) {
          ok = false
          data = (e as Error).message
        }
        void this.sealAndSend(from, s, { k: 'res', id: msg.id, ok, data }).catch(() => {})
      } else if (msg.k === 'res' && msg.id !== undefined) {
        s.link?.resolve(msg.id, !!msg.ok, msg.data)
      } else if (msg.k === 'push' && Array.isArray(msg.data)) {
        await this.ingest(msg.data)
      }
    })
  }

  // ---------------- sync ----------------

  private async pull(link: Link) {
    try {
      const entries = (await link.request('manifest', {}, { timeoutMs: 30_000 })) as ManifestEntry[]
      if (!Array.isArray(entries)) return
      const missing = await missingFrom(entries)
      for (let i = 0; i < missing.length; i += 200) {
        const recs = await link.request('records', { ids: missing.slice(i, i + 200) }, { timeoutMs: 30_000 })
        if (Array.isArray(recs)) await this.ingest(recs)
      }
    } catch (err) {
      this.trace(`pull from ${link.friend.slice(0, 6)} failed: ${(err as Error).message}`)
    }
  }

  private async ingest(items: unknown[]) {
    const me = this.me!
    // friend lists first so later visibility checks see them; then posts before likes/comments
    const order = { friends: 0, profile: 1, post: 2, del: 3, like: 4, comment: 5 } as Record<string, number>
    const recs = items.map(verifyRecord).filter((r): r is Stored => !!r)
    recs.sort((a, b) => order[a.t] - order[b.t])
    let listsChanged = false
    for (const rec of recs) {
      if (!(await shouldAccept(me.id, rec))) continue
      if (await putRecord(rec)) {
        if (rec.t === 'friends') listsChanged = true
        for (const ref of mediaOf(rec)) this.enqueuePrefetch(ref, rec.by)
      }
    }
    if (listsChanged) this.schedulePresence()
  }

  /** Push a freshly authored record to every online friend allowed to see it. */
  private async broadcast(rec: Stored) {
    const vis = new Visibility(this.me!.id)
    for (const [friendId, link] of this.live) {
      if (await vis.canSee(friendId, rec)) link.push([rec] as unknown as JsonValue)
    }
    if (rec.t === 'friends') this.schedulePresence()
  }

  // ---------------- blobs ----------------

  private async fetchFrom(link: Link, hash: string): Promise<Uint8Array | null> {
    if (link.kind === 'direct') {
      const bytes = await link.request('blob', { hash }, { timeoutMs: 180_000, onProgress: (p) => peers.setProgress(hash, p) })
      return bytes instanceof Uint8Array && bytes.byteLength ? bytes : null
    }
    // mesh: fetch in chunks through the mutual friend
    const parts: Uint8Array[] = []
    let offset = 0
    let size = Infinity
    while (offset < size) {
      const res = (await link.request('blobRange', { hash, offset, len: MESH_CHUNK }, { timeoutMs: 60_000 })) as { size: number; b64?: string }
      if (!res?.size || !res.b64) return null
      size = res.size
      const chunk = fromB64(res.b64)
      if (!chunk.byteLength) return null
      parts.push(chunk)
      offset += chunk.byteLength
      peers.setProgress(hash, offset / size)
    }
    const out = new Uint8Array(offset)
    let at = 0
    for (const p of parts) out.set(p, (at += p.byteLength) - p.byteLength)
    return out
  }

  /** Fetch a blob from whoever is online, preferring its owner and direct links. Resolves true once stored locally. */
  fetchBlob(hash: string, mime: string, owner: string): Promise<boolean> {
    const existing = this.inflight.get(hash)
    if (existing) return existing
    const p = (async () => {
      if (await db.blobs.get(hash)) return true
      const rank = (l: Link) => (l.friend === owner ? 0 : 2) + (l.kind === 'direct' ? 0 : 1)
      const candidates = [...this.live.values()].sort((a, b) => rank(a) - rank(b))
      for (const link of candidates) {
        try {
          peers.setProgress(hash, 0)
          const bytes = await this.fetchFrom(link, hash)
          if (!bytes) continue
          if ((await sha256Hex(bytes)) !== hash) continue // tampered or corrupt
          await putBlob(hash, new Blob([bytes as BlobPart], { type: mime }), mime)
          this.wanted.delete(hash)
          return true
        } catch {
          // try next link
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
    __socialp: {
      net,
      debug: () => net.debugState(),
      blockDirect: (id: string) => net.blockDirect(id),
      simulateDirectFailure: (key: string) => (net as unknown as { onConnectFailed(k: string): Promise<void> }).onConnectFailed(key),
    },
  })
