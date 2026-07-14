import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY diagnostic — scans FM restaurants for the "auto-disable" fingerprint
// (onlineOrderingAllowed=false + empty fulfillmentOptions + blocked=false) using
// the same FM service-account access the Full Sync uses. Gated by a one-time
// token; REMOVE this route after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = '0dc050c38a28ba74726c999c6a8d58f5972e856f4292b178'

type R = Record<string, unknown>
const foEmpty = (r: R) => { const f = r.fulfillmentOptions; return !f || (Array.isArray(f) && f.length === 0) }
const fp = (r: R) => r.onlineOrderingAllowed === false && foEmpty(r) && r.blocked === false
const active = (r: R) => ['ACCEPTED', 'ACTIVE'].includes(String(r.restaurantStatus || r.status || '').toUpperCase())

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const h = await getFmServiceAuthHeader()

  // Fetch all restaurants — page 0 first to learn totalPages, then the rest in
  // parallel batches (sequential over ~22 pages timed out).
  const SIZE = 200
  const fetchPage = async (page: number): Promise<{ content: R[]; raw: R }> => {
    const p = new URLSearchParams(); if (page > 0) p.set('page', String(page)); p.set('size', String(SIZE))
    const res = await fetch(`${FM}/api/admin/restaurants?${p}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) throw new Error(`list page ${page} HTTP ${res.status}`)
    const d = await res.json().catch(() => null)
    return { content: Array.isArray(d) ? d : ((d?.content || d?.data || []) as R[]), raw: (d || {}) as R }
  }
  const all: R[] = []
  let p0: { content: R[]; raw: R }
  try { p0 = await fetchPage(0) } catch (e) { return NextResponse.json({ error: String(e) }, { status: 502 }) }
  all.push(...p0.content)
  const totalPages = typeof p0.raw.totalPages === 'number' ? p0.raw.totalPages
    : typeof p0.raw.totalElements === 'number' ? Math.ceil(p0.raw.totalElements / SIZE)
    : (p0.content.length < SIZE ? 1 : null)
  const remaining = totalPages != null ? Array.from({ length: totalPages - 1 }, (_, i) => i + 1) : []
  for (let i = 0; i < remaining.length; i += 8) {
    const batch = await Promise.all(remaining.slice(i, i + 8).map(pg => fetchPage(pg).then(r => r.content).catch(() => [] as R[])))
    for (const b of batch) all.push(...b)
  }

  const matches = all.filter(fp)
  const matchesActive = all.filter(r => active(r) && fp(r))
  const c = (arr: R[], f: (r: R) => boolean) => arr.filter(f).length

  // DeCheco's — find + pull detail (for lat/lng) + Stripe status.
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
    const addrComplete = !!(a.addressLine1 && a.city && a.state && a.zipcode && a.latitude != null && a.longitude != null)
    const nsPhones = Array.isArray(ns.phoneNumber) ? ns.phoneNumber.filter((x: unknown) => String(x || '').trim()) : []
    const contactPresent = nsPhones.length > 0 || !!String(admin.phoneNumber || '').trim()
    decheco.push({
      businessName: r.businessName, reference: ref,
      onlineOrderingAllowed: r.onlineOrderingAllowed, blocked: r.blocked,
      fulfillmentOptions: r.fulfillmentOptions, fulfillmentEmpty: foEmpty(r),
      restaurantStatus: r.restaurantStatus || r.status,
      matchesAutoDisableFingerprint: fp(r),
      conditions: {
        addressComplete: addrComplete,
        addressDetail: { line1: a.addressLine1, city: a.city, state: a.state, zip: a.zipcode, lat: a.latitude ?? null, lng: a.longitude ?? null },
        contactPhonePresent: contactPresent,
        stripeConnected,
      },
    })
  }

  return NextResponse.json({
    totalRestaurants: all.length,
    activeCount: c(all, active),
    decheco,
    bulkScan: {
      fingerprint_all: matches.length,
      fingerprint_active: matchesActive.length,
      context: {
        onlineOrderingAllowed_false: c(all, r => r.onlineOrderingAllowed === false),
        onlineOrderingAllowed_true: c(all, r => r.onlineOrderingAllowed === true),
        blocked_true: c(all, r => r.blocked === true),
        ooaFalse_blockedTrue_manualToggle: c(all, r => r.onlineOrderingAllowed === false && r.blocked === true),
        ooaFalse_emptyFO_blockedTrue: c(all, r => r.onlineOrderingAllowed === false && foEmpty(r) && r.blocked === true),
      },
      amongActiveMatches: {
        haveCompleteStreetAddress: c(matchesActive, r => { const a = (r.address || {}) as R; return !!(a.addressLine1 && a.city && a.state && a.zipcode) }),
        haveAdminPhone: c(matchesActive, r => !!String(((r.admin || {}) as R).phoneNumber || '').trim()),
      },
      sampleActiveMatches: matchesActive.slice(0, 20).map(r => r.businessName),
    },
  })
}
