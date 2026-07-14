import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY diagnostic — scans FM restaurants for the "auto-disable" fingerprint
// (onlineOrderingAllowed=false + empty fulfillmentOptions + blocked=false) using
// the same FM service-account access the Full Sync uses. CHUNKED to stay under
// the function timeout: ?key=X&start=<page>&count=<n> scans a page range and
// returns aggregate counts for that chunk; the caller sums across chunks.
// Gated by a one-time token; REMOVE this route after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = '0dc050c38a28ba74726c999c6a8d58f5972e856f4292b178'
const SIZE = 200

type R = Record<string, unknown>
const foEmpty = (r: R) => { const f = r.fulfillmentOptions; return !f || (Array.isArray(f) && f.length === 0) }
const fp = (r: R) => r.onlineOrderingAllowed === false && foEmpty(r) && r.blocked === false
const active = (r: R) => ['ACCEPTED', 'ACTIVE'].includes(String(r.restaurantStatus || r.status || '').toUpperCase())
const c = (arr: R[], f: (r: R) => boolean) => arr.filter(f).length

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  if (q.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const h = await getFmServiceAuthHeader()
  const start = Math.max(0, parseInt(q.get('start') || '0', 10) || 0)
  const count = Math.min(6, Math.max(1, parseInt(q.get('count') || '6', 10) || 6))

  const fetchPage = async (page: number): Promise<{ content: R[]; raw: R }> => {
    const p = new URLSearchParams(); if (page > 0) p.set('page', String(page)); p.set('size', String(SIZE))
    const res = await fetch(`${FM}/api/admin/restaurants?${p}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) throw new Error(`list page ${page} HTTP ${res.status}`)
    const d = await res.json().catch(() => null)
    return { content: Array.isArray(d) ? d : ((d?.content || d?.data || []) as R[]), raw: (d || {}) as R }
  }

  // Fetch this chunk's pages in parallel.
  const pages = Array.from({ length: count }, (_, i) => start + i)
  let results: { content: R[]; raw: R }[]
  try { results = await Promise.all(pages.map(fetchPage)) } catch (e) { return NextResponse.json({ error: String(e) }, { status: 502 }) }
  const all: R[] = results.flatMap(r => r.content)
  const raw0 = results[0]?.raw || {}
  const totalPages = typeof raw0.totalPages === 'number' ? raw0.totalPages : null
  const totalElements = typeof raw0.totalElements === 'number' ? raw0.totalElements : null

  const matchesActive = all.filter(r => active(r) && fp(r))

  // DeCheco's — if present in this chunk, pull detail (lat/lng) + Stripe status.
  const dechs = all.filter(r => /decheco/i.test(String(r.businessName || '')))
  const decheco: R[] = []
  for (const r of dechs) {
    const ref = String(r.reference || '')
    let detail: R = {}
    try { const dr = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' }); if (dr.ok) detail = await dr.json() } catch { /* best-effort */ }
    let stripeConnected: boolean | null = null
    try { const sr = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: h, cache: 'no-store' }); stripeConnected = sr.ok } catch { stripeConnected = null }
    const a = (detail.address || r.address || {}) as R
    const admin = (detail.admin || r.admin || {}) as R
    const ns = (detail.notificationSetting || {}) as R
    const nsPhones = Array.isArray(ns.phoneNumber) ? ns.phoneNumber.filter((x: unknown) => String(x || '').trim()) : []
    decheco.push({
      businessName: r.businessName, reference: ref,
      onlineOrderingAllowed: r.onlineOrderingAllowed, blocked: r.blocked,
      fulfillmentOptions: r.fulfillmentOptions, fulfillmentEmpty: foEmpty(r),
      restaurantStatus: r.restaurantStatus || r.status,
      matchesAutoDisableFingerprint: fp(r),
      conditions: {
        addressComplete: !!(a.addressLine1 && a.city && a.state && a.zipcode && a.latitude != null && a.longitude != null),
        addressDetail: { line1: a.addressLine1, city: a.city, state: a.state, zip: a.zipcode, lat: a.latitude ?? null, lng: a.longitude ?? null },
        contactPhonePresent: nsPhones.length > 0 || !!String(admin.phoneNumber || '').trim(),
        stripeConnected,
      },
    })
  }

  return NextResponse.json({
    chunk: { start, count, pagesReturned: results.filter(r => r.content.length > 0).length },
    totalPages, totalElements,
    lastPageInChunk: all.length < count * SIZE, // fewer than requested → likely end
    countsThisChunk: {
      restaurants: all.length,
      active: c(all, active),
      fingerprint_all: c(all, fp),
      fingerprint_active: matchesActive.length,
      ooaFalse: c(all, r => r.onlineOrderingAllowed === false),
      ooaTrue: c(all, r => r.onlineOrderingAllowed === true),
      blockedTrue: c(all, r => r.blocked === true),
      ooaFalse_blockedTrue_manualToggle: c(all, r => r.onlineOrderingAllowed === false && r.blocked === true),
      activeMatch_haveStreetAddr: c(matchesActive, r => { const a = (r.address || {}) as R; return !!(a.addressLine1 && a.city && a.state && a.zipcode) }),
      activeMatch_haveAdminPhone: c(matchesActive, r => !!String(((r.admin || {}) as R).phoneNumber || '').trim()),
    },
    sampleActiveMatches: matchesActive.slice(0, 15).map(r => r.businessName),
    decheco,
  })
}
