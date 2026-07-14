import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY, token-gated READ-ONLY diagnostic — inspects a restaurant's FM detail
// (the single admin the detail exposes = getAdmins().findFirst) and searches FM
// users by term to reveal ALL associated admins + their phones. REMOVE after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = '429ceb76f211772fd29592b5802309926b707bf586ba8d64'
type R = Record<string, unknown>

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  if (q.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const ref = q.get('ref') || ''
  const search = q.get('search') || ''
  const h = await getFmServiceAuthHeader()

  let detail: R | null = null
  if (ref) {
    try { const r = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' }); detail = r.ok ? await r.json() : { httpStatus: r.status } } catch (e) { detail = { error: String(e) } }
  }
  const a = (detail?.address || {}) as R
  const admin = (detail?.admin || {}) as R
  const restaurantSummary = detail && !detail.httpStatus ? {
    businessName: detail.businessName,
    onlineOrderingAllowed: detail.onlineOrderingAllowed,
    restaurantStatus: detail.restaurantStatus || detail.status,
    blocked: detail.blocked,
    fulfillmentOptions: detail.fulfillmentOptions,
    // The detail's `admin` = getAdmins().findFirst() — ONE admin only.
    firstAdminExposedByDetail: { email: admin.email, firstName: admin.firstName, lastName: admin.lastName, phoneNumber: admin.phoneNumber || null },
    addressPhone: a.phoneNumber || null,
    addressComplete: !!(a.addressLine1 && a.city && a.state && a.zipcode && a.latitude != null && a.longitude != null),
  } : detail

  let users: R[] = []
  if (search) {
    try {
      const r = await fetch(`${FM}/api/admin/users?search=${encodeURIComponent(search)}&size=50`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
      if (r.ok) { const d = await r.json(); const content = Array.isArray(d) ? d : (d?.content || d?.data || []); users = (content as R[]).map(u => ({ email: u.email, firstName: u.firstName, lastName: u.lastName, phoneNumber: u.phoneNumber || null, enabled: u.enabled })) }
    } catch { /* ignore */ }
  }

  return NextResponse.json({ restaurantSummary, usersMatchingSearch: users })
}
