/**
 * Quick NAT probe: gather server-reflexive candidates against two STUN servers.
 *  - one public IPv4 mapping            -> "cone" (endpoint-independent NAT; direct usually works)
 *  - several mappings for one address   -> "symmetric" (carrier NAT, hotspots; direct almost never works)
 *  - no reflexive candidate at all      -> "blocked" (UDP blocked; only a TCP/TLS relay can help)
 * Browsers de-duplicate identical reflexive candidates, so a cone NAT yields a single srflx per family.
 */
export type NatType = 'cone' | 'symmetric' | 'blocked' | 'unknown'

export interface NatInfo {
  type: NatType
  ipv6: boolean
}

const PROBE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']

/** Pure classification, exported for tests. `srflx` are candidate strings ("ip port"). */
export function classify(srflx: { address: string; port: number }[]): NatInfo {
  const v4 = srflx.filter((c) => !c.address.includes(':'))
  const ipv6 = srflx.some((c) => c.address.includes(':'))
  if (!v4.length) return { type: ipv6 ? 'cone' : 'blocked', ipv6 }
  const ports = new Map<string, Set<number>>()
  for (const c of v4) ports.set(c.address, (ports.get(c.address) ?? new Set()).add(c.port))
  const symmetric = [...ports.values()].some((p) => p.size > 1) || ports.size > 1
  return { type: symmetric ? 'symmetric' : 'cone', ipv6 }
}

let cached: Promise<NatInfo> | null = null

export function probeNat(timeoutMs = 4000): Promise<NatInfo> {
  cached ??= (async () => {
    if (typeof RTCPeerConnection === 'undefined') return { type: 'unknown' as NatType, ipv6: false }
    const pc = new RTCPeerConnection({ iceServers: PROBE_SERVERS.map((urls) => ({ urls })) })
    const srflx: { address: string; port: number }[] = []
    try {
      pc.createDataChannel('probe')
      pc.onicecandidate = (e) => {
        const c = e.candidate
        if (c?.type === 'srflx' && c.address && c.port) srflx.push({ address: c.address, port: c.port })
      }
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs)
        pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && (clearTimeout(t), resolve())
      })
      return classify(srflx)
    } catch {
      return { type: 'unknown' as NatType, ipv6: false }
    } finally {
      pc.close()
    }
  })()
  return cached
}
