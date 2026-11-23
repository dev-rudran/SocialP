import { create } from 'zustand'
import { getIdentity, getSettings, setIdentity, wipeEverything } from '../core/db'
import { generateIdentity, type Identity } from '../core/identity'
import { net } from '../p2p/net'

interface SessionState {
  ready: boolean
  identity: Identity | null
  persisted: boolean | null
}

export const useSession = create<SessionState>(() => ({ ready: false, identity: null, persisted: null }))

async function requestPersistence() {
  try {
    const persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.())
    useSession.setState({ persisted: !!persisted })
  } catch {
    useSession.setState({ persisted: false })
  }
}

export const session = {
  async boot() {
    const identity = (await getIdentity()) ?? null
    applyTheme((await getSettings()).theme)
    useSession.setState({ ready: true, identity })
    if (identity) {
      void requestPersistence()
      void net.start(identity)
    }
  },
  async createNew(): Promise<Identity> {
    const identity = generateIdentity()
    await setIdentity(identity)
    useSession.setState({ identity })
    void requestPersistence()
    void net.start(identity)
    return identity
  },
  async loggedIn(identity: Identity) {
    useSession.setState({ identity })
    void requestPersistence()
    await net.start(identity)
  },
  async wipe() {
    await net.stop()
    await wipeEverything()
    location.replace(location.pathname + location.search)
  },
}

export function applyTheme(theme: 'system' | 'light' | 'dark') {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.theme = theme
}
