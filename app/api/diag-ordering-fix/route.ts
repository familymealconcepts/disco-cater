import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY, token-gated maintenance endpoint — copies each restaurant's
// business/address phone into the admin (contact) phone so FM's ordering
// validation passes and a future save can't auto-disable ordering. Processes a
// batch SEQUENTIALLY and STOPS on the first anomaly (save failed, phone didn't
// persist, or ordering flipped OFF). Mirrors the admin edit's GET→merge→PUT.
// REMOVE after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = 'a66b70eb4c76af299a7dd13c86c2d69541b411aaba791041'

type R = Record<string, unknown>
const blank = (v: unknown) => !String(v ?? '').trim()

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
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

    // ── Preconditions (skip, don't save) ──
    if (!businessPhone) { results.push({ ref, name, status: 'SKIP', reason: 'no business phone to copy' }); continue }
    if (adminPhoneBefore) { results.push({ ref, name, status: 'SKIP', reason: 'admin phone already set', adminPhone: adminPhoneBefore }); continue }
    if (!addressComplete) { results.push({ ref, name, status: 'SKIP', reason: 'address incomplete — a save would fail address validation' }); continue }
    if (!(await stripeOk(ref))) { results.push({ ref, name, status: 'SKIP', reason: 'Stripe not connected — a save would fail Stripe validation' }); continue }

    if (dryRun) { results.push({ ref, name, status: 'WOULD_FIX', businessPhone, ooaBefore }); continue }

    // ── Fix: set admin.phoneNumber = businessPhone, PUT the full merged object ──
    const merged = { ...before, admin: { ...admin, phoneNumber: businessPhone } }
    const fd = new FormData()
    fd.append('restaurant', new Blob([JSON.stringify(merged)], { type: 'application/json' }), 'restaurant.json')
    let putStatus = 0, putBody = ''
    try { const pr = await fetch(`${FM}/api/admin/restaurants/${ref}`, { method: 'PUT', headers: h, body: fd }); putStatus = pr.status; if (!pr.ok) putBody = (await pr.text().catch(() => '')).slice(0, 500) } catch (e) { putStatus = 0; putBody = String(e) }
    if (putStatus < 200 || putStatus >= 300) { results.push({ ref, name, status: 'ANOMALY', reason: `PUT failed (HTTP ${putStatus})`, fmError: putBody, ooaBefore }); stopped = true; stopReason = `save failed for ${name} (${ref})`; break }

    // ── Verify ──
    const after = await getDetail(ref)
    const afterAdminPhone = String(((after?.admin || {}) as R).phoneNumber || '').trim()
    const afterOoa = after?.onlineOrderingAllowed === true
    if (!afterAdminPhone) { results.push({ ref, name, status: 'ANOMALY', reason: 'phone did not persist after save', ooaBefore, ooaAfter: afterOoa }); stopped = true; stopReason = `phone not saved for ${name} (${ref})`; break }
    if (!afterOoa) { results.push({ ref, name, status: 'ANOMALY', reason: 'online ordering turned OFF by the save', businessPhone, ooaBefore, ooaAfter: false }); stopped = true; stopReason = `ordering disabled for ${name} (${ref})`; break }

    results.push({ ref, name, status: 'FIXED', phoneSet: afterAdminPhone, ooaAfter: true })
  }

  const summary = {
    requested: refs.length,
    fixed: results.filter(r => r.status === 'FIXED').length,
    skipped: results.filter(r => r.status === 'SKIP').length,
    wouldFix: results.filter(r => r.status === 'WOULD_FIX').length,
    anomalies: results.filter(r => r.status === 'ANOMALY').length,
    stopped, stopReason,
  }
  return NextResponse.json({ summary, results })
}
