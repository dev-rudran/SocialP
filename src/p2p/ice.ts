import type { TurnServerConfig } from 'trystero'
import { getSettings } from '../core/db'

/**
 * TURN relay credentials.
 *
 * The built-in relay is configured at build time, either as
 *  - VITE_TURN_ICE: a JSON array of ICE servers with static credentials, or
 *  - VITE_TURN_ENDPOINT: a URL returning ICE servers as a bare array (Metered credential API) or as
 *    { iceServers: [...] } (Cloudflare / a self-hosted credential service).
 * A TURN server set in Settings → Network replaces it.
 *
 * Privacy: these are only fetched once a direct connection has failed (or the user chose "always relay"),
 * so the relay operator never learns about users whose connections work peer-to-peer.
 */
const ENDPOINT = (import.meta.env.VITE_TURN_ENDPOINT as string | undefined) || undefined
const STATIC = parseStatic(import.meta.env.VITE_TURN_ICE as string | undefined)
const CACHE_MS = 6 * 60 * 60 * 1000

let cache: { at: number; servers: TurnServerConfig[] } | null = null
let pending: Promise<TurnServerConfig[]> | null = null

export const hasBuiltInRelay = () => !!ENDPOINT || STATIC.length > 0

function parseStatic(json: string | undefined): TurnServerConfig[] {
  if (!json) return []
  try {
    return normalize(JSON.parse(json))
  } catch {
    console.warn('[p2p] VITE_TURN_ICE is not valid JSON')
    return []
  }
}

type RawIce = { urls: string | string[]; username?: string; credential?: string }

function normalize(json: unknown): TurnServerConfig[] {
  const list = (Array.isArray(json) ? json : ((json as { iceServers?: RawIce[] })?.iceServers ?? [])) as RawIce[]
  return list
    .map((s) => ({
      // only TURN entries; port 53 is blocked by browsers and just causes timeouts
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => /^turns?:/i.test(u) && !/:53(\?|$)/.test(u)),
      username: s.username,
      credential: s.credential,
    }))
    .filter((s) => s.urls.length > 0)
}

export async function relayServers(): Promise<TurnServerConfig[]> {
  const s = await getSettings()
  if (s.turnUrl) return [{ urls: s.turnUrl, username: s.turnUser || undefined, credential: s.turnPass || undefined }]
  if (STATIC.length) return STATIC
  if (!ENDPOINT) return []
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.servers
  pending ??= (async () => {
    try {
      const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(8000), credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const servers = normalize(await res.json())
      if (servers.length) cache = { at: Date.now(), servers }
      return servers
    } catch (err) {
      console.warn('[p2p] relay credentials unavailable:', err)
      return []
    } finally {
      pending = null
    }
  })()
  return pending
}
