import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY diagnostic — for restaurants that currently have online ordering ON
// (onlineOrderingAllowed=true), check FM's three ordering-validation conditions
// (complete address incl. lat/lng, a contact phone [notification OR admin], and a
// connected Stripe account) and return those that FAIL ≥1 — i.e. would be
// auto-disabled on their next save. Chunked by page range. REMOVE after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = '0dc050c38a28ba74726c999c6a8d58f5972e856f4292b178'
const SIZE = 200

type R = Record<string, unknown>
const blank = (v: unknown) => !String(v ?? '').trim()

async function mapPool<T, U>(items: T[], limit: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  }))
  return out
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  if (q.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const h = await getFmServiceAuthHeader()
  const start = Math.max(0, parseInt(q.get('start') || '0', 10) || 0)
  const count = Math.min(4, Math.max(1, parseInt(q.get('count') || '3', 10) || 3))

  const fetchPage = async (page: number): Promise<{ content: R[]; raw: R }> => {
    const p = new URLSearchParams(); if (page > 0) p.set('page', String(page)); p.set('size', String(SIZE))
    const res = await fetch(`${FM}/api/admin/restaurants?${p}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) throw new Error(`list page ${page} HTTP ${res.status}`)
    const d = await res.json().catch(() => null)
    return { content: Array.isArray(d) ? d : ((d?.content || d?.data || []) as R[]), raw: (d || {}) as R }
  }

  const pages = Array.from({ length: count }, (_, i) => start + i)
  let results: { content: R[]; raw: R }[]
  try { results = await Promise.all(pages.map(fetchPage)) } catch (e) { return NextResponse.json({ error: String(e) }, { status: 502 }) }
  const all: R[] = results.flatMap(r => r.content)
  const totalPages = typeof results[0]?.raw.totalPages === 'number' ? (results[0].raw.totalPages as number) : null

  // Only restaurants with ordering currently ON can LOSE it on the next save.
  const on = all.filter(r => r.onlineOrderingAllowed === true)

  const checked = await mapPool(on, 8, async (r) => {
    const ref = String(r.reference || '')
    let detail: R = {}
    try { const dr = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' }); if (dr.ok) detail = await dr.json() } catch { /* best-effort */ }
    let stripe: boolean | null = null
    try { const sr = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: h, cache: 'no-store' }); stripe = sr.ok } catch { stripe = null }
    const a = (detail.address || r.address || {}) as R
    const admin = (detail.admin || r.admin || {}) as R
    const ns = (detail.notificationSetting || {}) as R
    const nsPhones = Array.isArray(ns.phoneNumber) ? ns.phoneNumber.filter((x: unknown) => !blank(x)) : []
    const addressOk = !blank(a.addressLine1) && !blank(a.city) && !blank(a.state) && !blank(a.zipcode) && a.latitude != null && a.longitude != null
    const contactOk = nsPhones.length > 0 || !blank(admin.phoneNumber)
    const stripeOk = stripe === true
    const fails: string[] = []
    if (!addressOk) fails.push('address' + (a.latitude == null || a.longitude == null ? '(lat/lng)' : ''))
    if (!contactOk) fails.push('contactPhone')
    if (!stripeOk) fails.push('stripe')
    return { ref, name: r.businessName, fails, fulfillmentEmpty: !r.fulfillmentOptions || (Array.isArray(r.fulfillmentOptions) && (r.fulfillmentOptions as unknown[]).length === 0),
      adminPhone: !blank(admin.phoneNumber), notifPhone: nsPhones.length > 0, addressPhone: !blank(a.phoneNumber) }
  })

  const atRisk = checked.filter(c => c.fails.length > 0)
  const byCondition = {
    onlyContactPhone: atRisk.filter(c => c.fails.length === 1 && c.fails[0] === 'contactPhone').length,
    onlyStripe: atRisk.filter(c => c.fails.length === 1 && c.fails[0] === 'stripe').length,
    onlyAddress: atRisk.filter(c => c.fails.length === 1 && c.fails[0].startsWith('address')).length,
    multiple: atRisk.filter(c => c.fails.length > 1).length,
    contactButHasAddressPhone: atRisk.filter(c => c.fails.includes('contactPhone') && c.addressPhone).length,
  }

  return NextResponse.json({
    chunk: { start, count }, totalPages,
    orderingOnInChunk: on.length,
    atRiskCount: atRisk.length,
    byCondition,
    atRisk: atRisk.map(c => ({ name: c.name, ref: c.ref, fails: c.fails, hasAddressPhoneButNoContactPhone: c.addressPhone && c.fails.includes('contactPhone') })),
  })
}
