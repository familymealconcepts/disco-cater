import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// TEMPORARY, token-gated READ-ONLY diagnostic — re-checks the CONTACT condition
// the way FM actually validates it: notification phone OR **any** linked admin
// has a phone (getAdmins().anyMatch), instead of only the first admin the detail
// exposes. For each restaurant it returns: the first admin (detail), and every
// OTHER phone-bearing user linked to the same restaurant (restaurantReference==R),
// discovered by searching FM users by the admin's email domain. Caveats: can't see
// the notification-setting phone (not exposed to admin), and can't find an admin
// whose email domain differs from the first admin's (or generic domains). REMOVE
// after use.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TOKEN = '4630bdd393ce10040851015bc13a9cc29364d4dac23ceed2'
const GENERIC = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'me.com', 'live.com', 'msn.com', 'comcast.net'])
type R = Record<string, unknown>
const blank = (v: unknown) => !String(v ?? '').trim()

async function mapPool<T, U>(items: T[], limit: number, fn: (t: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) } }))
  return out
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('key') !== TOKEN) return NextResponse.json({ error: 'nope' }, { status: 401 })
  const body = await req.json().catch(() => null) as { refs?: string[] } | null
  const refs = Array.isArray(body?.refs) ? body!.refs.map(String) : []
  if (!refs.length) return NextResponse.json({ error: 'refs[] required' }, { status: 400 })
  const h = await getFmServiceAuthHeader()

  const getJson = async (url: string): Promise<R | null> => { try { const r = await fetch(url, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' }); return r.ok ? await r.json() : null } catch { return null } }

  const results = await mapPool(refs, 6, async (ref) => {
    const detail = await getJson(`${FM}/api/admin/restaurants/${ref}`)
    if (!detail) return { ref, error: 'load failed' }
    const admin = (detail.admin || {}) as R
    const firstAdmin = { ref: admin.reference ? String(admin.reference) : null, email: String(admin.email || ''), phone: String(admin.phoneNumber || '').trim() || null }
    const domain = (firstAdmin.email.split('@')[1] || '').toLowerCase()
    const searchable = !!domain && !GENERIC.has(domain)

    // Find OTHER phone-bearing admins linked to THIS restaurant (restaurantReference==R).
    const otherPhoneAdmins: { email: string; phone: string }[] = []
    if (searchable) {
      const term = domain.split('.')[0]
      const list = await getJson(`${FM}/api/admin/users?search=${encodeURIComponent(term)}&size=50`)
      const content = (Array.isArray(list) ? list : (list?.content || list?.data || [])) as R[]
      const phoneUsers = content.filter(u => !blank(u.phoneNumber) && String(u.reference || '') !== firstAdmin.ref)
      await mapPool(phoneUsers, 6, async (u) => {
        const ud = await getJson(`${FM}/api/admin/users/${String(u.reference)}`)
        if (ud && String(ud.restaurantReference || '') === ref) otherPhoneAdmins.push({ email: String(u.email || ''), phone: String(u.phoneNumber) })
      })
    }
    return {
      ref, name: String(detail.businessName || ''),
      onlineOrderingAllowed: detail.onlineOrderingAllowed === true,
      firstAdminEmail: firstAdmin.email, firstAdminPhone: firstAdmin.phone,
      addressPhone: String(((detail.address || {}) as R).phoneNumber || '').trim() || null,
      otherPhoneAdmins, domainSearchable: searchable, domain,
    }
  })

  return NextResponse.json({ count: results.length, results })
}
