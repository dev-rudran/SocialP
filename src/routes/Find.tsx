import { Check, Copy, Link2, Search, UserPlus } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { addFriend } from '../core/actions'
import { ID_RE, normalizeId } from '../core/identity'
import { useFriends, useMe } from '../state/hooks'
import { Avatar } from '../ui/Avatar'
import { Button, Input, Modal, copy, shareLink } from '../ui/common'
import { Username } from '../ui/PostCard'

function useQr(text: string) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    void QRCode.toDataURL(text, { margin: 1, width: 480, color: { dark: '#0b0b0f', light: '#ffffff' } }).then(setSrc)
  }, [text])
  return src
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="flex w-full items-center gap-3 rounded-lg bg-elev px-3 py-2.5 text-left text-sm"
      onClick={() => {
        void copy(value)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{label}</span>
        <span className="block truncate font-mono">{value}</span>
      </span>
      {done ? <Check size={18} className="text-emerald-500" /> : <Copy size={18} />}
    </button>
  )
}

export function ShareIdModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe()!
  const link = shareLink(me.id)
  const qr = useQr(link)
  return (
    <Modal open={open} onClose={onClose} title="Your ID">
      <div className="space-y-4 p-5">
        <div className="mx-auto w-56 rounded-2xl bg-white p-3">{qr && <img src={qr} alt="QR code with your ID" className="w-full" />}</div>
        <CopyRow label="Profile ID" value={me.id} />
        <CopyRow label="Invite link" value={link} />
        <p className="text-xs text-muted">Anyone with your ID can send you a friend request. They only see your posts after you accept.</p>
      </div>
    </Modal>
  )
}

export function Find() {
  const { id: prefill } = useParams()
  const me = useMe()!
  const nav = useNavigate()
  const friends = useFriends()
  const [value, setValue] = useState(prefill ?? '')
  const [error, setError] = useState('')
  const [share, setShare] = useState(false)
  const id = normalizeId(value)
  const valid = ID_RE.test(id)

  const submit = async () => {
    setError('')
    try {
      await addFriend(id)
      nav(`/u/${id}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const accepted = friends.filter((f) => f.status === 'accepted')
  const outgoing = friends.filter((f) => f.status === 'outgoing')

  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold">Find friends</h1>
      <div className="relative">
        <Search size={18} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && submit()}
          placeholder="Paste a 32-character ID or invite link"
          className="pl-10 font-mono"
          autoFocus
        />
      </div>
      {value && !valid && <p className="mt-2 text-xs text-muted">IDs are 32 characters: letters a–z and digits 2–7.</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {valid && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-line p-3">
          <Avatar id={id} size={44} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{id}</span>
          <Button onClick={submit} disabled={id === me.id}>
            <UserPlus size={16} /> {friends.some((f) => f.id === id && f.status === 'incoming') ? 'Accept' : 'Add'}
          </Button>
        </div>
      )}

      <button onClick={() => setShare(true)} className="mt-6 flex w-full items-center gap-3 rounded-xl bg-elev p-4 text-left">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Link2 size={20} />
        </span>
        <span>
          <span className="block font-semibold">Share your ID</span>
          <span className="block text-sm text-muted">QR code, invite link, or copy the ID</span>
        </span>
      </button>

      {outgoing.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-semibold">Pending requests</h2>
          {outgoing.map((f) => (
            <Link key={f.id} to={`/u/${f.id}`} className="flex items-center gap-3 py-2 text-sm">
              <Avatar id={f.id} size={44} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.id}</span>
              <span className="text-xs text-muted">Waiting for them to come online</span>
            </Link>
          ))}
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 font-semibold">Friends · {accepted.length}</h2>
        {accepted.map((f) => (
          <Link key={f.id} to={`/u/${f.id}`} className="flex items-center gap-3 py-2 text-sm">
            <Avatar id={f.id} size={44} showOnline />
            <Username id={f.id} />
          </Link>
        ))}
        {!accepted.length && <p className="text-sm text-muted">No friends yet.</p>}
      </section>
      <ShareIdModal open={share} onClose={() => setShare(false)} />
    </div>
  )
}
