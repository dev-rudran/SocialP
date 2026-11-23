import { describe, expect, it } from 'vitest'
import { generateIdentity } from '../core/identity'
import { MeshSession } from './seal'

async function pair() {
  const a = generateIdentity(), b = generateIdentity()
  const sa = new MeshSession(a, b.id), sb = new MeshSession(b, a.id)
  expect(await sb.accept(sa.hello())).toBe(true)
  expect(await sa.accept(sb.hello())).toBe(true)
  return { a, b, sa, sb }
}

describe('mesh sessions', () => {
  it('round-trips sealed frames between the two friends', async () => {
    const { sa, sb } = await pair()
    const f = await sa.seal({ k: 'req', op: 'manifest', id: 1 })
    expect(await sb.open(f)).toEqual({ k: 'req', op: 'manifest', id: 1 })
    expect(await sa.open(await sb.seal('pong'))).toBe('pong')
  })

  it('rejects tampered, replayed and misdirected frames', async () => {
    const { sa, sb } = await pair()
    const f = await sa.seal({ secret: 'post' })
    const flipped = { ...f, ct: f.ct.slice(0, -4) + (f.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') }
    await expect(sb.open(flipped)).rejects.toThrow()
    await sb.open(f)
    await expect(sb.open(f)).rejects.toThrow(/replayed/)
    // a frame sealed for b can't be opened by a (direction is bound into the AAD)
    const g = await sa.seal('x')
    await expect(sa.open(g)).rejects.toThrow()
  })

  it('refuses hellos signed by someone else (the friend in the middle can’t impersonate)', async () => {
    const a = generateIdentity(), b = generateIdentity(), mallory = generateIdentity()
    const sb = new MeshSession(b, a.id)
    const forged = { ...new MeshSession(mallory, b.id).hello(), from: a.id }
    expect(await sb.accept(forged)).toBe(false)
    const hello = new MeshSession(a, b.id).hello()
    expect(await sb.accept({ ...hello, eph: new MeshSession(mallory, b.id).eph })).toBe(false)
  })
})
