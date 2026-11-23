import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromB64, toB64, utf8 } from '../lib/encoding'
import { pubMatchesId, signText, verifyText, type Identity } from '../core/identity'

/**
 * End-to-end encrypted sessions for traffic relayed through a mutual friend ("mesh").
 * Each side sends a hello with a fresh X25519 key signed by its Ed25519 identity, so the friend in the middle
 * can neither read nor forge anything. Messages are AES-256-GCM with a per-direction monotonic counter
 * (replays and reordering attacks are rejected).
 */

export interface Hello {
  t: 'hello'
  from: string
  pub: string
  eph: string
  ts: number
  sig: string
}

export interface Sealed {
  t: 'data'
  n: number
  iv: string
  ct: string
}

const helloMsg = (from: string, to: string, eph: string, ts: number) => `socialp-mesh-v1|${from}|${to}|${eph}|${ts}`
const MAX_SKEW = 10 * 60 * 1000

export class MeshSession {
  private secret = x25519.utils.randomSecretKey()
  readonly eph = toB64(x25519.getPublicKey(this.secret))
  private key: CryptoKey | null = null
  private theirEph: string | null = null
  private sendN = 0
  private recvN = 0
  private ready: Promise<void>
  private markReady!: () => void
  private me: Identity
  private peer: string

  constructor(me: Identity, peer: string) {
    this.me = me
    this.peer = peer
    this.ready = new Promise((r) => (this.markReady = r))
  }

  hello(): Hello {
    const ts = Date.now()
    return { t: 'hello', from: this.me.id, pub: this.me.pub, eph: this.eph, ts, sig: signText(helloMsg(this.me.id, this.peer, this.eph, ts), this.me.secret) }
  }

  get established() {
    return !!this.key
  }

  waitReady(ms: number) {
    return Promise.race([this.ready, new Promise<void>((_, rej) => setTimeout(() => rej(new Error('mesh handshake timeout')), ms))])
  }

  /** Verify the peer's hello and derive the session key. Returns false if it's not authentic. */
  async accept(h: Hello): Promise<boolean> {
    if (h.from !== this.peer || !pubMatchesId(h.pub, h.from)) return false
    if (Math.abs(Date.now() - h.ts) > MAX_SKEW) return false
    if (!verifyText(h.sig, helloMsg(h.from, this.me.id, h.eph, h.ts), h.pub)) return false
    if (this.theirEph === h.eph && this.key) return true
    const shared = x25519.getSharedSecret(this.secret, fromB64(h.eph))
    const ids = [this.me.id, this.peer].sort().join('|')
    const raw = hkdf(sha256, shared, utf8(ids), utf8('socialp-mesh-v1'), 32)
    this.key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
    this.theirEph = h.eph
    this.sendN = 0
    this.recvN = 0
    this.markReady()
    return true
  }

  async seal(payload: unknown): Promise<Sealed> {
    if (!this.key) throw new Error('mesh session not established')
    const n = ++this.sendN
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const pt = utf8(JSON.stringify(payload))
    const ad = utf8(`${this.me.id}>${this.peer}#${n}`)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, this.key, pt as BufferSource))
    return { t: 'data', n, iv: toB64(iv), ct: toB64(ct) }
  }

  async open(s: Sealed): Promise<unknown> {
    if (!this.key) throw new Error('mesh session not established')
    if (!(s.n > this.recvN)) throw new Error('replayed or reordered mesh frame')
    const ad = utf8(`${this.peer}>${this.me.id}#${s.n}`)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(s.iv) as BufferSource, additionalData: ad }, this.key, fromB64(s.ct) as BufferSource)
    this.recvN = s.n
    return JSON.parse(new TextDecoder().decode(pt))
  }
}
