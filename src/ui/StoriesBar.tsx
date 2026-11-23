import { Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { displayName, useMe, useProfile, useStories } from '../state/hooks'
import { Avatar } from './Avatar'

function StoryBubble({ id, ring, label, to, add }: { id: string; ring?: 'seen' | 'unseen'; label?: string; to: string; add?: boolean }) {
  const p = useProfile(id)
  return (
    <Link to={to} className="flex w-[72px] shrink-0 flex-col items-center gap-1">
      <span className="relative">
        <Avatar id={id} size={60} ring={ring ?? 'seen'} />
        {add && (
          <span className="absolute right-0 bottom-0 flex h-5 w-5 items-center justify-center rounded-full border-2 border-bg bg-accent text-accent-fg">
            <Plus size={12} strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-xs">{label ?? displayName(p, id)}</span>
    </Link>
  )
}

export function StoriesBar() {
  const me = useMe()
  const groups = useStories()
  if (!me) return null
  const mine = groups.find((g) => g.by === me.id)
  const others = groups.filter((g) => g.by !== me.id)
  return (
    <div className="no-scrollbar flex gap-2 overflow-x-auto px-3 py-3 sm:px-0">
      <StoryBubble
        id={me.id}
        label="Your story"
        to={mine ? `/stories/${me.id}` : '/create?story=1'}
        ring={mine ? (mine.allSeen ? 'seen' : 'unseen') : undefined}
        add={!mine}
      />
      {others.map((g) => (
        <StoryBubble key={g.by} id={g.by} ring={g.allSeen ? 'seen' : 'unseen'} to={`/stories/${g.by}`} />
      ))}
    </div>
  )
}
