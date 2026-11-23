import { describe, expect, it } from 'vitest'
import { classify } from './nat'

describe('NAT classification', () => {
  it('one public mapping is a cone NAT (direct works)', () => {
    expect(classify([{ address: '203.0.113.7', port: 50000 }])).toEqual({ type: 'cone', ipv6: false })
  })

  it('different mapped ports for one address is symmetric (carrier NAT / hotspot)', () => {
    expect(
      classify([
        { address: '203.0.113.7', port: 50000 },
        { address: '203.0.113.7', port: 50122 },
      ]).type,
    ).toBe('symmetric')
  })

  it('different public addresses per server is symmetric too (CGNAT pools)', () => {
    expect(
      classify([
        { address: '203.0.113.7', port: 50000 },
        { address: '203.0.113.9', port: 50000 },
      ]).type,
    ).toBe('symmetric')
  })

  it('no reflexive candidates means UDP is blocked', () => {
    expect(classify([])).toEqual({ type: 'blocked', ipv6: false })
  })

  it('IPv6-only reachability counts as direct-capable', () => {
    expect(classify([{ address: '2001:db8::1', port: 40000 }])).toEqual({ type: 'cone', ipv6: true })
  })
})
