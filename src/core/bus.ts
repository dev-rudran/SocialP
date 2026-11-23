import type { Stored } from './records'

type Events = {
  /** a record authored on this device — should be pushed to friends */
  local: Stored
  /** friend list / friend statuses changed — network should reconcile rooms */
  friends: void
  /** settings affecting the network changed */
  network: void
}

type Handler<T> = (payload: T) => void
const handlers = new Map<keyof Events, Set<Handler<never>>>()

export function on<K extends keyof Events>(event: K, fn: Handler<Events[K]>) {
  let set = handlers.get(event)
  if (!set) handlers.set(event, (set = new Set()))
  set.add(fn as Handler<never>)
  return () => void set.delete(fn as Handler<never>)
}

export function emit<K extends keyof Events>(event: K, payload: Events[K]) {
  handlers.get(event)?.forEach((fn) => (fn as Handler<Events[K]>)(payload))
}
