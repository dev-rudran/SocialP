import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

export function Logo({ className = '' }: { className?: string }) {
  return <span className={`font-brand font-bold tracking-tight brand-text ${className}`}>SocialP</span>
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-accent text-accent-fg hover:opacity-90',
    secondary: 'bg-elev text-fg hover:bg-line',
    ghost: 'text-accent hover:opacity-80',
    danger: 'bg-danger text-white hover:opacity-90',
  }[variant]
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-line bg-elev px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-muted ${props.className ?? ''}`}
    />
  )
}

export function Modal({ open, onClose, children, title, wide }: { open: boolean; onClose: () => void; children: ReactNode; title?: string; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className={`max-h-[90dvh] w-full overflow-auto rounded-t-2xl bg-bg sm:rounded-2xl ${wide ? 'sm:max-w-4xl' : 'sm:max-w-md'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg px-4 py-3">
            <span className="w-6" />
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close">
              <X size={22} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export function Menu({ open, onClose, items }: { open: boolean; onClose: () => void; items: { label: string; danger?: boolean; onClick: () => void }[] }) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="divide-y divide-line text-center text-sm">
        {items.map((it) => (
          <button
            key={it.label}
            className={`block w-full py-3.5 ${it.danger ? 'font-semibold text-danger' : ''}`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.label}
          </button>
        ))}
        <button className="block w-full py-3.5" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full border-2 border-fg">{icon}</div>
      <h3 className="text-2xl font-bold">{title}</h3>
      {children && <div className="mt-2 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  )
}

export function copy(text: string) {
  return navigator.clipboard?.writeText(text)
}

export function shareLink(id: string) {
  return `${location.origin}${location.pathname}#/add/${id}`
}
