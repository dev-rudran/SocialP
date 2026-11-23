import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronRight, Download, HardDrive, Moon, Network, QrCode, ShieldCheck, Trash2, User } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { exportProfile } from '../core/archive'
import { emit } from '../core/bus'
import { cacheStats, db, evictCache, FRIEND_MEDIA_TTL, getSettings, updateSettings, type Settings as S } from '../core/db'
import { usePeers } from '../state/peers'
import { applyTheme, session, useSession } from '../state/session'
import { Button, Input, copy } from '../ui/common'
import { ShareIdModal } from './Find'
import { net } from '../p2p/net'
import { hasBuiltInRelay } from '../p2p/ice'
import { displayName, useFriends, useMe } from '../state/hooks'
import { Avatar } from '../ui/Avatar'

function Row({ icon, title, sub, to, onClick }: { icon: ReactNode; title: string; sub?: string; to?: string; onClick?: () => void }) {
  const body = (
    <span className="flex items-center gap-4 px-4 py-3.5 hover:bg-elev">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{title}</span>
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </span>
      <ChevronRight size={18} className="text-muted" />
    </span>
  )
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    <button onClick={onClick} className="block w-full text-left">
      {body}
    </button>
  )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl py-6">
      <h1 className="mb-4 px-4 text-2xl font-bold">{title}</h1>
      {children}
    </div>
  )
}

export function Settings() {
  const me = useMe()!
  const [share, setShare] = useState(false)
  const persisted = useSession((s) => s.persisted)
  const usage = useLiveQuery(async () => {
    const est = await navigator.storage?.estimate?.()
    return est?.usage ? `${(est.usage / 1024 / 1024).toFixed(1)} MB used` : undefined
  }, [])
  return (
    <Page title="Settings">
      <div className="divide-y divide-line border-y border-line">
        <Row icon={<User size={22} />} title="Edit profile" to="/settings/profile" />
        <Row icon={<QrCode size={22} />} title="Your ID" sub={me.id} onClick={() => setShare(true)} />
        <Row icon={<Download size={22} />} title="Export profile" sub="Encrypted archive to move to another device" to="/settings/export" />
        <Row icon={<Network size={22} />} title="Network" sub="Signaling relays and TURN" to="/settings/network" />
        <Row icon={<HardDrive size={22} />} title="Storage" sub="Cache limit for friends' media" to="/settings/storage" />
        <Row icon={<Moon size={22} />} title="Appearance" to="/settings/appearance" />
        <Row icon={<ShieldCheck size={22} />} title="Privacy & how it works" to="/settings/privacy" />
      </div>
      <p className="flex items-center gap-2 px-4 pt-4 text-xs text-muted">
        <HardDrive size={14} />
        {usage ?? 'Storage'} · {persisted ? 'persistent storage granted' : 'browser may evict data under storage pressure — keep a backup'}
      </p>
      <div className="px-4 pt-8">
        <Button
          variant="secondary"
          className="w-full text-danger"
          onClick={() => {
            if (confirm('Log out and erase this profile from this browser? Without an export it cannot be recovered.')) void session.wipe()
          }}
        >
          <Trash2 size={16} /> Log out & erase from this device
        </Button>
      </div>
      <ShareIdModal open={share} onClose={() => setShare(false)} />
    </Page>
  )
}

export function ExportPage() {
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [withFriends, setWithFriends] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const me = useMe()!

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const blob = await exportProfile(pass, { includeFriendsContent: withFriends })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `socialp-${me.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.socialp`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
      await updateSettings({ lastBackupAt: Date.now() })
      setDone(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page title="Export profile">
      <div className="space-y-4 px-4">
        <p className="text-sm text-muted">
          Creates a single <b>.socialp</b> file with your keys, profile, posts, stories, friends and settings, encrypted with a passphrase (Argon2id + AES-256-GCM).
          Import it on another device to log in. <b>Anyone with this file and the passphrase becomes you</b>, so store it safely.
        </p>
        <Input type="password" placeholder="Passphrase (min 8 characters)" value={pass} onChange={(e) => setPass(e.target.value)} />
        <Input type="password" placeholder="Repeat passphrase" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withFriends} onChange={(e) => setWithFriends(e.target.checked)} />
          Also include friends' posts cached on this device (bigger file)
        </label>
        {pass2 && pass !== pass2 && <p className="text-sm text-danger">Passphrases don't match.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        {done && <p className="text-sm text-emerald-500">Exported. Keep the file and passphrase somewhere safe.</p>}
        <Button className="w-full" disabled={busy || pass.length < 8 || pass !== pass2} onClick={run}>
          <Download size={16} /> {busy ? 'Encrypting…' : 'Export archive'}
        </Button>
      </div>
    </Page>
  )
}

export function NetworkPage() {
  const settings = useLiveQuery(getSettings, [])
  if (!settings) return null
  return <NetworkForm initial={settings} />
}

function NetworkForm({ initial }: { initial: S }) {
  const [relays, setRelays] = useState(initial.relayUrls.join('\n'))
  const [turnUrl, setTurnUrl] = useState(initial.turnUrl)
  const [turnUser, setTurnUser] = useState(initial.turnUser)
  const [turnPass, setTurnPass] = useState(initial.turnPass)
  const [policy, setPolicy] = useState(initial.relayPolicy)
  const [saved, setSaved] = useState(false)
  const online = usePeers((s) => s.online.size)
  const lastError = usePeers((s) => s.lastError)
  const nav = useNavigate()

  const save = async () => {
    const relayUrls = relays
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^wss?:\/\//.test(s))
    await updateSettings({ relayUrls, turnUrl: turnUrl.trim(), turnUser: turnUser.trim(), turnPass, relayPolicy: policy })
    emit('network', undefined)
    setSaved(true)
    setTimeout(() => nav('/settings'), 600)
  }

  return (
    <Page title="Network">
      <div className="space-y-5 px-4 text-sm">
        <p className="text-muted">
          Peers find each other through signaling relays (Nostr). Relays only see encrypted handshakes, never your posts. Media flows directly between browsers.
          Currently connected to <b>{online}</b> friend{online === 1 ? '' : 's'}.
          {lastError && <span className="block text-amber-500">{lastError}</span>}
        </p>
        <div>
          <label className="mb-2 block font-semibold">Relay (TURN)</label>
          <div className="space-y-2">
            {(
              [
                ['auto', 'Only when needed', 'Connect directly; fall back to the relay only if your networks block it (hotspots, mobile data). Recommended.'],
                ['always', 'Always relay', 'Friends never see your IP address; the relay operator does. Slower.'],
                ['never', 'Never', 'Direct connections only. Some friends may be unreachable.'],
              ] as const
            ).map(([value, title, sub]) => (
              <label key={value} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${policy === value ? 'border-accent' : 'border-line'}`}>
                <input type="radio" name="relay" checked={policy === value} onChange={() => setPolicy(value)} className="mt-1" />
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-xs text-muted">{sub}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            The relay forwards end-to-end encrypted traffic and can't read your posts. It does see IP addresses and traffic volume.
            {!hasBuiltInRelay() && !turnUrl && ' No relay is configured in this build; add your own TURN server below.'}
          </p>
        </div>
        <div>
          <label className="mb-1 block font-semibold">Custom signaling relays</label>
          <textarea
            value={relays}
            onChange={(e) => setRelays(e.target.value)}
            rows={3}
            placeholder={'wss://relay.example.com\n(leave empty for public defaults)'}
            className="w-full resize-none rounded-lg border border-line bg-elev px-3 py-2.5 font-mono text-xs outline-none"
          />
          <p className="mt-1 text-xs text-muted">One per line. Run your own Nostr relay for full control. Friends must share at least one relay with you.</p>
        </div>
        <div className="space-y-2">
          <label className="block font-semibold">Own TURN server (optional)</label>
          <Input placeholder="turn:turn.example.com:3478" value={turnUrl} onChange={(e) => setTurnUrl(e.target.value)} />
          <div className="flex gap-2">
            <Input placeholder="Username" value={turnUser} onChange={(e) => setTurnUser(e.target.value)} />
            <Input placeholder="Password" type="password" value={turnPass} onChange={(e) => setTurnPass(e.target.value)} />
          </div>
          <p className="text-xs text-muted">Replaces the built-in relay. Leave empty to use the default.</p>
        </div>
        <Button className="w-full" onClick={save}>
          {saved ? 'Saved — reconnecting…' : 'Save & reconnect'}
        </Button>
        <Diagnostics />
      </div>
    </Page>
  )
}

function Diagnostics() {
  const [state, setState] = useState(() => net.debugState())
  const [copied, setCopied] = useState(false)
  const friends = useFriends()
  const online = usePeers((s) => s.online)
  const links = usePeers((s) => s.links)
  const relay = usePeers((s) => s.relay)
  const nat = usePeers((s) => s.nat)
  useEffect(() => {
    const t = setInterval(() => setState(net.debugState()), 2000)
    return () => clearInterval(t)
  }, [])
  const openRelays = state.signaling.filter((r) => r.open).length
  const report = JSON.stringify({ at: new Date().toISOString(), ua: navigator.userAgent, ...state }, null, 1)
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <h2 className="font-semibold">Connection diagnostics</h2>
      <ul className="space-y-1 text-xs">
        <li>
          Signaling relays: <b className={openRelays ? 'text-emerald-500' : 'text-danger'}>{openRelays}/{state.signaling.length} connected</b>
        </li>
        <li>
          Your network:{' '}
          <b className={nat?.type === 'symmetric' || nat?.type === 'blocked' ? 'text-amber-500' : ''}>
            {nat?.type === 'cone'
              ? 'direct connections possible'
              : nat?.type === 'symmetric'
                ? 'strict NAT (mobile data / hotspot): friends or relay needed'
                : nat?.type === 'blocked'
                  ? 'UDP blocked: relay needed'
                  : 'checking…'}
            {nat?.ipv6 ? ' · IPv6' : ''}
          </b>
        </li>
        <li>
          TURN relay:{' '}
          <b className={relay === 'unavailable' ? 'text-danger' : ''}>
            {relay === 'active' ? 'in use' : relay === 'unavailable' ? 'needed but unavailable' : 'not needed so far'}
          </b>
        </li>
      </ul>
      <div className="space-y-2">
        {friends
          .filter((f) => f.status !== 'incoming')
          .map((f) => (
            <FriendLink key={f.id} id={f.id} status={f.status} online={online.has(f.id)} link={links.get(f.id)} />
          ))}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">Technical log</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-elev p-2 whitespace-pre-wrap">{state.log.slice(-60).join('\n') || 'empty'}</pre>
      </details>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => {
          void copy(report)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? 'Copied' : 'Copy diagnostics report'}
      </Button>
      <p className="text-xs text-muted">The report contains shortened IDs and connection events, no posts or keys.</p>
    </section>
  )
}

function FriendLink({ id, status, online, link }: { id: string; status: string; online: boolean; link?: string }) {
  const p = useLiveQuery(() => db.records.get(`profile:${id}`), [id]) as { username?: string } | undefined
  const viaId = link?.startsWith('via:') ? link.slice(4) : undefined
  const via = useLiveQuery(async () => (viaId ? db.records.get(`profile:${viaId}`) : undefined), [viaId]) as { username?: string } | undefined
  const label = online
    ? viaId
      ? `connected through ${displayName(via as never, viaId)}`
      : link === 'relay'
        ? 'connected via relay'
        : link === 'direct'
          ? 'connected directly'
          : 'connected'
    : status === 'outgoing'
      ? 'request pending'
      : 'offline'
  return (
    <div className="flex items-center gap-3 text-xs">
      <Avatar id={id} size={28} />
      <span className="flex-1 truncate">{displayName(p as never, id)}</span>
      <span className={online ? 'text-emerald-500' : 'text-muted'}>{label}</span>
    </div>
  )
}

export function AppearancePage() {
  const settings = useLiveQuery(getSettings, [])
  const set = async (theme: S['theme']) => {
    await updateSettings({ theme })
    applyTheme(theme)
  }
  return (
    <Page title="Appearance">
      <div className="divide-y divide-line border-y border-line">
        {(['system', 'light', 'dark'] as const).map((t) => (
          <label key={t} className="flex items-center justify-between px-4 py-3.5 text-sm capitalize">
            {t}
            <input type="radio" name="theme" checked={settings?.theme === t} onChange={() => void set(t)} />
          </label>
        ))}
      </div>
    </Page>
  )
}

export function PrivacyPage() {
  const me = useMe()!
  const counts = useLiveQuery(async () => ({ records: await db.records.count(), blobs: await db.blobs.count() }), [])
  const items: [string, string][] = [
    ['Identity', `Your ID is derived from an Ed25519 public key generated in this browser. Everything you publish is signed, so friends can verify it really came from you, even when it's relayed by someone else.`],
    ['Storage', `Posts, stories and media live in this browser's IndexedDB (${counts?.records ?? 0} records, ${counts?.blobs ?? 0} media files). Nothing is uploaded to a server.`],
    ['Sharing', `Content travels over WebRTC (DTLS-encrypted) only to friends you've accepted. Friends keep copies and can pass your posts to people on your friend list while you're offline. Never to anyone else.`],
    ['What friends see', `Accepted friends see your posts, stories, profile and friend list. People who know your ID can send you a request but see nothing until you accept.`],
    ['Limits', `Removing a friend stops future sharing, but can't erase what they already received. Deleting a post asks friends' devices to delete it too. Stories expire after 24 hours. Direct connections reveal your IP address to friends.`],
    ['Friends relaying', `If you and a friend can't connect directly, a mutual friend who is connected to both of you can pass your traffic along. It is end-to-end encrypted between you and your friend, so the friend in the middle can't read or change anything. They only learn that the two of you are exchanging data. Friends only tell each other which of your mutual friends are online right now; nobody else learns it.`],
    ['Relay', `When two networks block direct connections (common on mobile data and hotspots), traffic goes through a TURN relay. It is end-to-end encrypted, so the relay can't read anything, but it sees both IP addresses and how much data flows. The relay is only contacted when a direct connection fails, or always if you choose "Always relay" to hide your IP from friends.`],
    ['Backups', `If this browser's data is cleared and you have no export, your profile is gone for good. Nobody can recover it. Friends may still hold your posts and will sync them back once you import your archive.`],
  ]
  return (
    <Page title="Privacy & how it works">
      <div className="space-y-5 px-4 text-sm">
        {items.map(([h, b]) => (
          <section key={h}>
            <h2 className="mb-1 font-semibold">{h}</h2>
            <p className="text-muted">{b}</p>
          </section>
        ))}
        <button className="font-mono text-xs text-muted" onClick={() => void copy(me.id)}>
          {me.id}
        </button>
      </div>
    </Page>
  )
}

const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`)
const LIMITS = [250, 500, 1024, 2048, 5120]

export function StoragePage() {
  const settings = useLiveQuery(getSettings, [])
  const [tick, setTick] = useState(0)
  const stats = useLiveQuery(cacheStats, [tick])
  const [msg, setMsg] = useState('')
  const persisted = useSession((s) => s.persisted)
  if (!settings) return null
  const clear = async (all: boolean) => {
    const r = await evictCache({ all })
    setMsg(r.removed ? `Freed ${mb(r.freed)} (${r.removed} files). They'll be re-fetched from friends if you open them again.` : 'Nothing to clean up.')
    setTick((t) => t + 1)
  }
  return (
    <Page title="Storage">
      <div className="space-y-5 px-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-elev p-3">
            <p className="text-xs text-muted">Your media</p>
            <p className="text-lg font-semibold">{stats ? mb(stats.own) : '…'}</p>
            <p className="text-xs text-muted">never removed</p>
          </div>
          <div className="rounded-xl bg-elev p-3">
            <p className="text-xs text-muted">Friends' cached media</p>
            <p className="text-lg font-semibold">{stats ? mb(stats.friends) : '…'}</p>
            <p className="text-xs text-muted">limit {mb(settings.cacheLimitMB * 1024 * 1024)}</p>
          </div>
        </div>
        <p className="text-muted">
          Friends' full-size photos and videos you haven't viewed for {FRIEND_MEDIA_TTL / 86_400_000} days are removed automatically. Captions, likes, comments and
          thumbnails stay, and the full file is fetched again from friends when you open it. If the cache grows past the limit, the least recently viewed media goes
          first. Keeping a cache lets you pass friends' posts to each other while they're offline.
        </p>
        <div>
          <label className="mb-1 block font-semibold">Cache limit</label>
          <select
            value={settings.cacheLimitMB}
            onChange={async (e) => {
              await updateSettings({ cacheLimitMB: Number(e.target.value) })
              await evictCache()
              setTick((t) => t + 1)
            }}
            className="w-full rounded-lg border border-line bg-elev px-3 py-2.5 outline-none"
          >
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {mb(l * 1024 * 1024)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => void clear(false)}>
            Clean up now
          </Button>
          <Button variant="secondary" className="flex-1 text-danger" onClick={() => void clear(true)}>
            Clear all friends' media
          </Button>
        </div>
        {msg && <p className="text-emerald-500">{msg}</p>}
        <p className="text-xs text-muted">{persisted ? 'Persistent storage granted by the browser.' : 'The browser has not granted persistent storage. Keep an export as a backup.'}</p>
      </div>
    </Page>
  )
}
