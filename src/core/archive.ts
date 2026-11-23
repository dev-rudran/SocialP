import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { argon2id } from 'hash-wasm'
import { pubMatchesId, type Identity } from './identity'
import { db, type BlobRow, type Friend, type Settings, getSettings } from './db'
import type { Stored } from './records'

/**
 * .socialp archive layout:
 *   "SOCIALP1" | salt(16) | iv(12) | AES-256-GCM( zip{ profile.json, blobs/<hash> } )
 * Key = Argon2id(passphrase, salt). The archive contains the secret key, so it is always encrypted.
 */
const MAGIC = 'SOCIALP1'
const KDF = { parallelism: 1, iterations: 3, memorySize: 64 * 1024, hashLength: 32 } as const

interface ArchiveJson {
  version: 1
  exportedAt: number
  identity: Identity
  settings: Settings
  friends: Friend[]
  records: Stored[]
  blobs: { hash: string; mime: string }[]
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const raw = await argon2id({ ...KDF, password: passphrase, salt, outputType: 'binary' })
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface ExportOptions {
  /** also include friends' posts cached on this device */
  includeFriendsContent?: boolean
}

export async function exportProfile(passphrase: string, opts: ExportOptions = {}): Promise<Blob> {
  if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters')
  const identity = (await db.meta.get('identity'))?.value as Identity
  if (!identity) throw new Error('No profile on this device')

  const all = await db.records.toArray()
  const records = opts.includeFriendsContent ? all : all.filter((r) => r.by === identity.id || r.t === 'profile' || isOnMine(r, all, identity.id))
  const wanted = new Set<string>()
  for (const r of records) {
    if (r.t === 'post') r.media.forEach((m) => (wanted.add(m.hash), m.thumb && wanted.add(m.thumb)))
    if (r.t === 'profile' && r.avatar) wanted.add(r.avatar.hash)
  }
  const blobs = (await db.blobs.bulkGet([...wanted])).filter((b): b is BlobRow => !!b)

  const json: ArchiveJson = {
    version: 1,
    exportedAt: Date.now(),
    identity,
    settings: await getSettings(),
    friends: await db.friends.toArray(),
    records,
    blobs: blobs.map((b) => ({ hash: b.hash, mime: b.mime })),
  }
  const files: Zippable = { 'profile.json': strToU8(JSON.stringify(json)) }
  for (const b of blobs) files[`blobs/${b.hash}`] = [new Uint8Array(await b.data.arrayBuffer()), { level: 0 }]
  const zip = zipSync(files, { level: 6 })

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zip as BufferSource))
  return new Blob([strToU8(MAGIC), salt, iv, ct] as BlobPart[], { type: 'application/octet-stream' })
}

/** likes/comments on my own posts are part of my profile */
function isOnMine(r: Stored, all: Stored[], me: string) {
  if (r.t !== 'like' && r.t !== 'comment') return false
  return all.some((p) => p.id === r.post && p.by === me)
}

export async function readArchive(file: Blob, passphrase: string): Promise<{ json: ArchiveJson; blobs: Map<string, Uint8Array> }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (strFromU8(bytes.subarray(0, 8)) !== MAGIC) throw new Error('This is not a SocialP profile archive')
  const salt = bytes.subarray(8, 24)
  const iv = bytes.subarray(24, 36)
  const key = await deriveKey(passphrase, salt)
  let zip: Uint8Array
  try {
    zip = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.subarray(36) as BufferSource))
  } catch {
    throw new Error('Wrong passphrase or corrupted archive')
  }
  const files = unzipSync(zip)
  const json = JSON.parse(strFromU8(files['profile.json'])) as ArchiveJson
  if (json.version !== 1 || !pubMatchesId(json.identity.pub, json.identity.id)) throw new Error('Archive identity is invalid')
  const blobs = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(files)) if (name.startsWith('blobs/')) blobs.set(name.slice(6), data)
  return { json, blobs }
}

/** Replaces everything on this device with the archive contents. */
export async function importProfile(file: Blob, passphrase: string): Promise<Identity> {
  const { json, blobs } = await readArchive(file, passphrase)
  const mimes = new Map(json.blobs.map((b) => [b.hash, b.mime]))
  await db.transaction('rw', [db.meta, db.records, db.blobs, db.friends, db.seen], async () => {
    await Promise.all([db.meta.clear(), db.records.clear(), db.blobs.clear(), db.friends.clear(), db.seen.clear()])
    await db.meta.bulkPut([
      { key: 'identity', value: json.identity },
      { key: 'settings', value: json.settings },
    ])
    await db.friends.bulkPut(json.friends)
    await db.records.bulkPut(json.records)
    const now = Date.now()
    await db.blobs.bulkPut(
      [...blobs].map(([hash, data]) => {
        const mime = mimes.get(hash) ?? 'application/octet-stream'
        return { hash, mime, size: data.byteLength, data: new Blob([data as BlobPart], { type: mime }), ts: now }
      }),
    )
  })
  return json.identity
}
