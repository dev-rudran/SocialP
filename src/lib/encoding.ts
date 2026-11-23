const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. 20 bytes -> 32 chars. */
export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const utf8 = (s: string) => new TextEncoder().encode(s)

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v ?? null)).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource)
  return toHex(new Uint8Array(digest))
}
