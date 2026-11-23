import { create } from 'zustand'

interface PeersState {
  /** friend ids with a live authenticated connection */
  online: Set<string>
  /** blob hashes currently downloading -> progress 0..1 */
  downloads: Map<string, number>
  status: 'offline' | 'connecting' | 'online'
  lastError?: string
  /** how each online friend is connected */
  links: Map<string, 'direct' | 'relay'>
  /** relay state: idle (not needed yet), active, unavailable (needed but no relay configured / reachable) */
  relay: 'idle' | 'active' | 'unavailable'
}

export const usePeers = create<PeersState>(() => ({ online: new Set(), downloads: new Map(), status: 'offline', links: new Map(), relay: 'idle' }))

export const peers = {
  setOnline(id: string, on: boolean) {
    usePeers.setState((s) => {
      const online = new Set(s.online)
      const links = new Map(s.links)
      if (on) online.add(id)
      else (online.delete(id), links.delete(id))
      return { online, links }
    })
  },
  setLink(id: string, kind: 'direct' | 'relay') {
    usePeers.setState((s) => ({ links: new Map(s.links).set(id, kind) }))
  },
  setRelay(relay: PeersState['relay']) {
    usePeers.setState({ relay })
  },
  setProgress(hash: string, p: number | null) {
    usePeers.setState((s) => {
      const downloads = new Map(s.downloads)
      if (p === null) downloads.delete(hash)
      else downloads.set(hash, p)
      return { downloads }
    })
  },
  setStatus(status: PeersState['status'], lastError?: string) {
    usePeers.setState({ status, lastError })
  },
  reset() {
    usePeers.setState({ online: new Set(), downloads: new Map(), status: 'offline', links: new Map(), relay: 'idle' })
  },
}
