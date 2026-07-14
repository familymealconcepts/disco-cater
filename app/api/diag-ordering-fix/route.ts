import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY, token-gated maintenance endpoint — copies each restaurant's
// business/address phone into the admin (contact) phone so FM's ordering
// validation passes and a future save can't auto-disable ordering.
//
// ?minimal=1 sends ONLY the fields FM's RestaurantAdminUpdateRequestDto expects
// (businessName, timezone, admin, address, leadGenOne/Two) instead of echoing the
// full record back — avoids FM crashing on odd extra fields.
//
// Sequential. A 2xx save that turns ordering OFF or doesn't persist the phone is a
// hard ANOMALY → STOP. A 5xx (FM server crash) is logged as SKIP_FM_ERROR and the
// batch CONTINUES (after confirming ordering wasn't harmed). Any other status
// (4xx/network) → STOP. REMOVE after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = 'a66b70eb4c76af299a7dd13c86c2d69541b411aaba791041'

type R = Record<string, unknown>
const blank = (v: unknown) => !String(v ?? '').trim()

function minimalPayload(before: R, businessPhone: string): R {
  const admin = (before.admin || {}) as R
  const a = (before.address || {}) as R
  return {
    businessName: before.businessName ?? null,
    timezone: before.timezone ?? null,
    admin: { firstName: admin.firstName ?? null, lastName: admin.lastName ?? null, email: admin.email ?? null, phoneNumber: businessPhone },
    address: {
      addressLine1: a.addressLine1 ?? null, addressLine2: a.addressLine2 ?? null,
      city: a.city ?? null, state: a.state ?? null, zipcode: a.zipcode ?? null,
      phoneNumber: a.phoneNumber ?? null, latitude: a.latitude ?? null, longitude: a.longitude ?? null,
    },
    leadGenOne: before.leadGenOne ?? null,
    leadGenTwo: before.leadGenTwo ?? null,
  }
}

export async function POST(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  if (sp.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const dryRun = sp.get('dryRun') === '1'
  const minimal = sp.get('minimal') === '1'
  const body = await req.json().catch(() => null) as { refs?: string[] } | null
  const refs = Array.isArray(body?.refs) ? body!.refs.map(String) : []
  if (!refs.length) return NextResponse.json({ error: 'refs[] required' }, { status: 400 })
  const h = await getFmServiceAuthHeader()

  const getDetail = async (ref: string): Promise<R | null> => {
    const r = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
    return r.ok ? (await r.json().catch(() => null)) as R : null
  }
  const stripeOk = async (ref: string): Promise<boolean> => {
    try { const r = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: h, cache: 'no-store' }); return r.ok } catch { return false }
  }

  const results: R[] = []
  let stopped = false, stopReason = ''

  for (const ref of refs) {
    const before = await getDetail(ref)
    if (!before) { results.push({ ref, status: 'ANOMALY', reason: 'could not load restaurant' }); stopped = true; stopReason = `load failed for ${ref}`; break }
    const name = String(before.businessName || '')
    const addr = (before.address || {}) as R
    const admin = (before.admin || {}) as R
    const businessPhone = String(addr.phoneNumber || '').trim()
    const adminPhoneBefore = String(admin.phoneNumber || '').trim()
    const ooaBefore = before.onlineOrderingAllowed === true
    const addressComplete = !blank(addr.addressLine1) && !blank(addr.city) && !blank(addr.state) && !blank(addr.zipcode) && addr.latitude != null && addr.longitude != null

    if (!businessPhone) { results.push({ ref, name, status: 'SKIP', reason: 'no business phone to copy' }); continue }
    if (adminPhoneBefore) { results.push({ ref, name, status: 'SKIP', reason: 'admin phone already set', adminPhone: adminPhoneBefore }); continue }
    if (!addressComplete) { results.push({ ref, name, status: 'SKIP', reason: 'address incomplete — a save would fail address validation' }); continue }
    if (!(await stripeOk(ref))) { results.push({ ref, name, status: 'SKIP', reason: 'Stripe not connected — a save would fail Stripe validation' }); continue }

    if (dryRun) { results.push({ ref, name, status: 'WOULD_FIX', businessPhone, ooaBefore, mode: minimal ? 'minimal' : 'full' }); continue }

    const payload = minimal ? minimalPayload(before, businessPhone) : { ...before, admin: { ...admin, phoneNumber: businessPhone } }
    const fd = new FormData()
    fd.append('restaurant', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'restaurant.json')
    let putStatus = 0, putBody = ''
    try { const pr = await fetch(`${FM}/api/admin/restaurants/${ref}`, { method: 'PUT', headers: h, body: fd }); putStatus = pr.status; if (!pr.ok) putBody = (await pr.text().catch(() => '')).slice(0, 400) } catch (e) { putStatus = 0; putBody = String(e) }

    if (putStatus >= 200 && putStatus < 300) {
      const after = await getDetail(ref)
      const afterAdminPhone = String(((after?.admin || {}) as R).phoneNumber || '').trim()
      const afterOoa = after?.onlineOrderingAllowed === true
      if (!afterAdminPhone) { results.push({ ref, name, status: 'ANOMALY', reason: 'phone did not persist after save', ooaBefore, ooaAfter: afterOoa }); stopped = true; stopReason = `phone not saved for ${name}`; break }
      if (!afterOoa) { results.push({ ref, name, status: 'ANOMALY', reason: 'online ordering turned OFF by the save', businessPhone, ooaBefore, ooaAfter: false }); stopped = true; stopReason = `ordering disabled for ${name}`; break }
      results.push({ ref, name, status: 'FIXED', phoneSet: afterAdminPhone, ooaAfter: true, mode: minimal ? 'minimal' : 'full' })
    } else if (putStatus >= 500 || putStatus === 0) {
      // FM server crash (or network) — confirm no harm, then skip + continue.
      const after = await getDetail(ref)
      const afterOoa = after?.onlineOrderingAllowed === true
      if (after && !afterOoa) { results.push({ ref, name, status: 'ANOMALY', reason: `ordering OFF after a failed save (HTTP ${putStatus})`, fmError: putBody, ooaBefore, ooaAfter: false }); stopped = true; stopReason = `ordering disabled by failed save for ${name}`; break }
      results.push({ ref, name, status: 'SKIP_FM_ERROR', reason: `FM server error (HTTP ${putStatus}) — could not fix; ordering unchanged (${afterOoa ? 'ON' : 'unknown'})`, fmError: putBody })
    } else {
      results.push({ ref, name, status: 'ANOMALY', reason: `unexpected PUT status HTTP ${putStatus}`, fmError: putBody, ooaBefore }); stopped = true; stopReason = `unexpected status ${putStatus} for ${name}`; break
    }
  }

  const count = (s: string) => results.filter(r => r.status === s).length
  return NextResponse.json({
    summary: { requested: refs.length, mode: minimal ? 'minimal' : 'full', fixed: count('FIXED'), skipped: count('SKIP'), skippedFmError: count('SKIP_FM_ERROR'), wouldFix: count('WOULD_FIX'), anomalies: count('ANOMALY'), stopped, stopReason },
    results,
  })
}
