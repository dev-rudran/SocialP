import { create } from 'zustand'

interface PeersState {
  /** friend ids with a live authenticated connection */
  online: Set<string>
  /** blob hashes currently downloading -> progress 0..1 */
  downloads: Map<string, number>
  status: 'offline' | 'connecting' | 'online'
  lastError?: string
}

export const usePeers = create<PeersState>(() => ({ online: new Set(), downloads: new Map(), status: 'offline' }))

export const peers = {
  setOnline(id: string, on: boolean) {
    usePeers.setState((s) => {
      const online = new Set(s.online)
      if (on) online.add(id)
      else online.delete(id)
      return { online }
    })
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
    usePeers.setState({ online: new Set(), downloads: new Map(), status: 'offline' })
  },
}
