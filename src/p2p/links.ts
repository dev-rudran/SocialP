import type { JsonValue, MessageAction, RequestAction } from 'trystero'

/**
 * A Link is "a way to talk to one friend", whatever the transport:
 *  - direct: a WebRTC connection in our pair room (possibly via a TURN relay)
 *  - mesh:   end-to-end encrypted frames forwarded by a mutual friend
 * Sync code only ever talks to Links, so it doesn't care how the bytes travel.
 */
export type Op = 'manifest' | 'records' | 'blob' | 'blobRange'

export interface RequestOpts {
  timeoutMs?: number
  onProgress?: (p: number) => void
}

export interface Link {
  readonly friend: string
  readonly kind: 'direct' | 'mesh'
  /** mesh only: the mutual friend forwarding our frames */
  readonly via?: string
  request(op: Op, data: JsonValue, opts?: RequestOpts): Promise<unknown>
  push(records: JsonValue): void
  close(): void
}

export interface DirectActions {
  manifest: RequestAction<JsonValue, JsonValue>
  records: RequestAction<{ ids: string[] }, JsonValue>
  blob: RequestAction<{ hash: string }, Uint8Array>
  push: MessageAction<JsonValue>
}

export class DirectLink implements Link {
  readonly kind = 'direct' as const
  readonly friend: string
  readonly peerId: string
  readonly owner: object
  private actions: DirectActions

  /** `owner` is the room context, used to tell which room a link belongs to. */
  constructor(friend: string, peerId: string, owner: object, actions: DirectActions) {
    this.friend = friend
    this.peerId = peerId
    this.owner = owner
    this.actions = actions
  }

  request(op: Op, data: JsonValue, opts: RequestOpts = {}): Promise<unknown> {
    const o = { target: this.peerId, timeoutMs: opts.timeoutMs ?? 30_000, onProgress: opts.onProgress && ((p: number) => opts.onProgress!(p)) }
    switch (op) {
      case 'manifest':
        return this.actions.manifest.request(data, o)
      case 'records':
        return this.actions.records.request(data as { ids: string[] }, o)
      case 'blob':
        return this.actions.blob.request(data as { hash: string }, o)
      default:
        return Promise.reject(new Error(`unsupported op on direct link: ${op}`))
    }
  }

  push(records: JsonValue) {
    void this.actions.push.send(records, { target: this.peerId }).catch(() => {})
  }

  close() {}
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class MeshLink implements Link {
  readonly kind = 'mesh' as const
  readonly friend: string
  readonly via: string
  private send: (payload: unknown) => Promise<void>
  private pending = new Map<number, Pending>()
  private nextId = 0
  private closed = false

  /** `send` seals and forwards one payload through the mutual friend. */
  constructor(friend: string, via: string, send: (payload: unknown) => Promise<void>) {
    this.friend = friend
    this.via = via
    this.send = send
  }

  request(op: Op, data: JsonValue, opts: RequestOpts = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('mesh link closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('mesh request timed out'))
      }, opts.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ k: 'req', id, op, data }).catch((e: Error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      })
    })
  }

  push(records: JsonValue) {
    if (!this.closed) void this.send({ k: 'push', data: records }).catch(() => {})
  }

  /** Called with a decrypted `res` payload. */
  resolve(id: number, ok: boolean, data: unknown) {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    if (ok) p.resolve(data)
    else p.reject(new Error(String(data ?? 'remote error')))
  }

  close() {
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('mesh link closed'))
    }
    this.pending.clear()
  }
}
