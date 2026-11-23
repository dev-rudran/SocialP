import * as ed from '@noble/ed25519'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { base32, fromB64, toB64, utf8 } from '../lib/encoding'

ed.hashes.sha512 = sha512

export interface Identity {
  id: string
  /** base64 ed25519 public key */
  pub: string
  /** base64 ed25519 secret key — never leaves the device unencrypted */
  secret: string
  createdAt: number
}

export const ID_LENGTH = 32
export const ID_RE = /^[a-z2-7]{32}$/

/** Public profile ID: base32(sha256(pubkey)[0..20]) — exactly 32 chars. */
export function deriveId(pub: Uint8Array): string {
  return base32(sha256(pub).slice(0, 20))
}

export function generateIdentity(): Identity {
  const { secretKey, publicKey } = ed.keygen()
  return { id: deriveId(publicKey), pub: toB64(publicKey), secret: toB64(secretKey), createdAt: Date.now() }
}

export function signBytes(msg: Uint8Array, secretB64: string): string {
  return toB64(ed.sign(msg, fromB64(secretB64)))
}

export function signText(msg: string, secretB64: string): string {
  return signBytes(utf8(msg), secretB64)
}

export function verifyText(sigB64: string, msg: string, pubB64: string): boolean {
  try {
    return ed.verify(fromB64(sigB64), utf8(msg), fromB64(pubB64))
  } catch {
    return false
  }
}

/** True if `pub` actually belongs to `id`. */
export function pubMatchesId(pubB64: string, id: string): boolean {
  try {
    return deriveId(fromB64(pubB64)) === id
  } catch {
    return false
  }
}

export function normalizeId(input: string): string {
  const trimmed = input.trim().toLowerCase()
  const m = trimmed.match(/[a-z2-7]{32}/)
  return m ? m[0] : trimmed
}
