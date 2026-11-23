import { Download, KeyRound, Lock, Upload, UserPlus, Wifi } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { importProfile } from '../core/archive'
import { session } from '../state/session'
import { Button, Input, Logo } from '../ui/common'

export function Welcome() {
  const nav = useNavigate()
  const [mode, setMode] = useState<'choose' | 'import'>('choose')
  const [file, setFile] = useState<File | null>(null)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const create = async () => {
    setBusy(true)
    await session.createNew()
    nav('/setup', { replace: true })
  }

  const doImport = async () => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const identity = await importProfile(file, pass)
      await session.loggedIn(identity)
      nav('/', { replace: true })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-2">
        <div className="hidden space-y-5 md:block">
          {[
            [Lock, 'No accounts, no servers', 'Your profile is a keypair generated on this device. Nobody else holds your data.'],
            [Wifi, 'Peer-to-peer', 'Photos, videos and stories travel directly between friends over encrypted WebRTC.'],
            [KeyRound, 'Portable', 'Export an encrypted archive and log in anywhere by importing it.'],
          ].map(([Icon, title, body]) => {
            const I = Icon as typeof Lock
            return (
              <div key={title as string} className="flex gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-elev">
                  <I size={20} />
                </span>
                <div>
                  <h3 className="font-semibold">{title as string}</h3>
                  <p className="text-sm text-muted">{body as string}</p>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mx-auto w-full max-w-sm">
          <div className="rounded-xl border border-line px-8 py-10">
            <div className="mb-8 text-center">
              <Logo className="text-4xl" />
              <p className="mt-3 text-sm text-muted">Share photos and videos with friends — privately.</p>
            </div>

            {mode === 'choose' ? (
              <div className="space-y-3">
                <Button className="w-full py-2.5" onClick={create} disabled={busy}>
                  <UserPlus size={18} /> Create new profile
                </Button>
                <div className="flex items-center gap-3 py-1 text-xs font-semibold text-muted">
                  <span className="h-px flex-1 bg-line" /> OR <span className="h-px flex-1 bg-line" />
                </div>
                <Button variant="secondary" className="w-full py-2.5" onClick={() => setMode('import')}>
                  <Upload size={18} /> Import profile
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <input ref={fileRef} type="file" accept=".socialp,application/octet-stream" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex w-full items-center gap-3 rounded-lg border border-dashed border-line p-4 text-left text-sm hover:bg-elev"
                >
                  <Download size={20} className="shrink-0" />
                  <span className="truncate">{file ? file.name : 'Choose your .socialp archive'}</span>
                </button>
                <Input type="password" placeholder="Archive passphrase" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doImport()} />
                {error && <p className="text-sm text-danger">{error}</p>}
                <p className="text-xs text-muted">Importing replaces anything stored in this browser. Avoid using the same profile on two devices at once.</p>
                <Button className="w-full" onClick={doImport} disabled={!file || !pass || busy}>
                  {busy ? 'Decrypting…' : 'Import & log in'}
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => setMode('choose')}>
                  Back
                </Button>
              </div>
            )}
          </div>
          <p className="mt-4 text-center text-xs text-muted">
            Everything is stored only in this browser. Clearing site data or losing this device without an export means losing your profile.
          </p>
        </div>
      </div>
    </div>
  )
}
