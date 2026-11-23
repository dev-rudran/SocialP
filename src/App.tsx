import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { db, garbageCollect } from './core/db'
import { Activity } from './routes/Activity'
import { Create } from './routes/Create'
import { EditProfile } from './routes/EditProfile'
import { Feed } from './routes/Feed'
import { Find } from './routes/Find'
import { PostPage } from './routes/PostPage'
import { Profile } from './routes/Profile'
import { AppearancePage, ExportPage, NetworkPage, PrivacyPage, Settings, StoragePage } from './routes/Settings'
import { StoryViewer } from './routes/StoryViewer'
import { Welcome } from './routes/Welcome'
import { useSession } from './state/session'
import { Layout } from './ui/Layout'
import { Logo } from './ui/common'

export default function App() {
  const { ready, identity } = useSession()
  const location = useLocation()
  const hasProfile = useLiveQuery(async () => (identity ? !!(await db.records.get(`profile:${identity.id}`)) : false), [identity?.id])

  useEffect(() => {
    if (!identity) return
    void garbageCollect()
    const t = setInterval(() => void garbageCollect(), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [identity])

  if (!ready || (identity && hasProfile === undefined))
    return (
      <div className="flex h-full items-center justify-center">
        <Logo className="animate-pulse text-4xl" />
      </div>
    )

  if (!identity) {
    // remember invite links so they still work after onboarding
    const m = location.pathname.match(/^\/add\/([a-z2-7]{32})/)
    if (m) sessionStorage.setItem('pendingAdd', m[1])
    return (
      <Routes>
        <Route path="*" element={<Welcome />} />
      </Routes>
    )
  }

  if (!hasProfile && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  if (hasProfile && location.pathname === '/setup') return <Navigate to="/" replace />

  const pendingAdd = sessionStorage.getItem('pendingAdd')
  if (hasProfile && pendingAdd) {
    sessionStorage.removeItem('pendingAdd')
    return <Navigate to={`/add/${pendingAdd}`} replace />
  }

  return (
    <Routes>
      <Route path="/setup" element={<EditProfile onboarding />} />
      <Route path="/stories/:userId" element={<StoryViewer />} />
      <Route element={<Layout />}>
        <Route index element={<Feed />} />
        <Route path="/find" element={<Find />} />
        <Route path="/add/:id" element={<Find />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/create" element={<Create />} />
        <Route path="/u/:id" element={<Profile />} />
        <Route path="/p/:id" element={<PostPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/profile" element={<EditProfile />} />
        <Route path="/settings/export" element={<ExportPage />} />
        <Route path="/settings/network" element={<NetworkPage />} />
        <Route path="/settings/storage" element={<StoragePage />} />
        <Route path="/settings/appearance" element={<AppearancePage />} />
        <Route path="/settings/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
