import { useLiveQuery } from 'dexie-react-hooks'
import { Heart, Home, Menu as MenuIcon, PlusSquare, Search, Settings, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { db } from '../core/db'
import { useMe } from '../state/hooks'
import { usePeers } from '../state/peers'
import { Avatar } from './Avatar'
import { Logo } from './common'

function useRequestCount() {
  return useLiveQuery(() => db.friends.where('status').equals('incoming').count(), [], 0)
}

function NetBadge() {
  const status = usePeers((s) => s.status)
  const online = usePeers((s) => s.online.size)
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted" title="Friends connected right now">
      <span className={`h-2 w-2 rounded-full ${status === 'online' ? (online ? 'bg-emerald-500' : 'bg-amber-400') : 'bg-line'}`} />
      {online} online
    </span>
  )
}

function SideItem({ to, icon, label, badge }: { to: string; icon: ReactNode; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => `relative flex items-center gap-4 rounded-lg p-3 transition hover:bg-elev ${isActive ? 'font-bold' : ''}`}
    >
      <span className="relative">
        {icon}
        {!!badge && <span className="absolute -top-1.5 -right-1.5 h-2.5 w-2.5 rounded-full bg-danger" />}
      </span>
      <span className="hidden xl:inline">{label}</span>
    </NavLink>
  )
}

export function Layout() {
  const me = useMe()
  const requests = useRequestCount()
  const { pathname } = useLocation()
  if (!me) return null
  const isHome = pathname === '/'

  return (
    <div className="min-h-full">
      {/* desktop / tablet sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] flex-col border-r border-line px-3 py-6 md:flex xl:w-[244px]">
        <NavLink to="/" className="mb-8 px-3">
          <Logo className="hidden text-2xl xl:inline" />
          <ShieldCheck className="xl:hidden" />
        </NavLink>
        <nav className="flex flex-1 flex-col gap-1">
          <SideItem to="/" icon={<Home />} label="Home" />
          <SideItem to="/find" icon={<Search />} label="Find friends" />
          <SideItem to="/activity" icon={<Heart />} label="Activity" badge={requests} />
          <SideItem to="/create" icon={<PlusSquare />} label="Create" />
          <SideItem to={`/u/${me.id}`} icon={<Avatar id={me.id} size={24} />} label="Profile" />
        </nav>
        <div className="mb-2 hidden px-3 xl:block">
          <NetBadge />
        </div>
        <SideItem to="/settings" icon={<MenuIcon />} label="Settings" />
      </aside>

      {/* mobile top bar (home only, like the familiar layout) */}
      {isHome && (
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-bg/95 px-4 backdrop-blur md:hidden">
          <Logo className="text-2xl" />
          <div className="flex items-center gap-5">
            <NetBadge />
            <NavLink to="/activity" className="relative" aria-label="Activity">
              <Heart />
              {!!requests && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-danger" />}
            </NavLink>
            <NavLink to="/settings" aria-label="Settings">
              <Settings />
            </NavLink>
          </div>
        </header>
      )}

      <main className="pb-16 md:pb-0 md:pl-[72px] xl:pl-[244px]">
        <Outlet />
      </main>

      {/* mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] md:hidden">
        <NavLink to="/" end aria-label="Home" className={({ isActive }) => (isActive ? '[&_svg]:stroke-[2.6]' : '')}>
          <Home />
        </NavLink>
        <NavLink to="/find" aria-label="Find friends" className={({ isActive }) => (isActive ? '[&_svg]:stroke-[2.6]' : '')}>
          <Search />
        </NavLink>
        <NavLink to="/create" aria-label="Create">
          <PlusSquare />
        </NavLink>
        <NavLink to="/activity" aria-label="Activity" className="relative">
          <Heart />
          {!!requests && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-danger" />}
        </NavLink>
        <NavLink to={`/u/${me.id}`} aria-label="Profile">
          <Avatar id={me.id} size={26} />
        </NavLink>
      </nav>
    </div>
  )
}
