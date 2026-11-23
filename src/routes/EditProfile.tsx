import { Camera } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { saveProfile } from '../core/actions'
import { processAvatar } from '../core/media'
import type { MediaRef } from '../core/records'
import { useBlobUrl, useMe, useProfile } from '../state/hooks'
import { Avatar } from '../ui/Avatar'
import { Button, Input } from '../ui/common'

export function EditProfile({ onboarding }: { onboarding?: boolean }) {
  const me = useMe()!
  const profile = useProfile(me.id)
  const nav = useNavigate()
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [avatar, setAvatar] = useState<MediaRef | undefined>()
  const [busy, setBusy] = useState(false)
  const loaded = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const avatarUrl = useBlobUrl(avatar, me.id)

  useEffect(() => {
    if (loaded.current || profile === undefined) return
    loaded.current = true
    setUsername(profile.username)
    setName(profile.name)
    setBio(profile.bio)
    setAvatar(profile.avatar)
  }, [profile])

  const valid = /^[a-z0-9._]{2,30}$/.test(username)

  const save = async () => {
    setBusy(true)
    await saveProfile({ username, name: name.trim(), bio: bio.trim(), avatar })
    nav(onboarding ? '/' : `/u/${me.id}`, { replace: true })
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-1 text-xl font-bold">{onboarding ? 'Set up your profile' : 'Edit profile'}</h1>
      {onboarding && <p className="mb-6 text-sm text-muted">This is what friends see. You can change it anytime.</p>}

      <div className="mb-6 flex items-center gap-4 rounded-2xl bg-elev p-4">
        <button onClick={() => fileRef.current?.click()} className="relative" aria-label="Change photo">
          {avatarUrl ? <img src={avatarUrl} className="h-16 w-16 rounded-full object-cover" alt="" /> : <Avatar id={me.id} size={64} />}
          <span className="absolute right-0 bottom-0 rounded-full bg-accent p-1 text-accent-fg">
            <Camera size={12} />
          </span>
        </button>
        <div className="min-w-0">
          <p className="font-semibold">{username || 'username'}</p>
          <button className="text-sm font-semibold text-accent" onClick={() => fileRef.current?.click()}>
            Change photo
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (f) setAvatar(await processAvatar(f))
          }}
        />
      </div>

      <label className="mb-1 block text-sm font-semibold">Username</label>
      <Input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))} placeholder="username" maxLength={30} autoFocus={onboarding} />
      <p className="mt-1 mb-4 text-xs text-muted">Lowercase letters, numbers, dots and underscores. Not unique — your 32-character ID is what identifies you.</p>

      <label className="mb-1 block text-sm font-semibold">Name</label>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={60} className="mb-4" />

      <label className="mb-1 block text-sm font-semibold">Bio</label>
      <textarea
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        maxLength={300}
        rows={3}
        placeholder="Bio"
        className="w-full resize-none rounded-lg border border-line bg-elev px-3 py-2.5 text-sm outline-none focus:border-muted"
      />
      <p className="mb-6 text-right text-xs text-muted">{bio.length} / 300</p>

      <Button className="w-full" disabled={!valid || busy} onClick={save}>
        {onboarding ? 'Continue' : 'Submit'}
      </Button>
    </div>
  )
}
