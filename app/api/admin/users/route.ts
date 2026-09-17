import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sanitizePhoneFields } from '../../../../lib/utils/phone'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { DISCO_USER_PREFIX } from '../../../../lib/admin/disco-user-ref'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// ── DISCO-NATIVE CUSTOMER ACCOUNTS ──────────────────────────────────────────
// A customer who signed up on Disco Cater has no FamilyMeal user, so this screen
// — which proxied FM alone — could not show them at all. /api/admin/customers
// already merges the same people into the Customers screen; this is the Users
// (accounts) half, and it uses the SAME `disco:<email>` reference convention the
// system-admins list uses so the sub-routes can route on it.
//
// Merged on the FIRST page only, like the Orders list does with native orders.

async function fetchNativeUsers(search: string): Promise<Record<string, unknown>[]> {
  try {
    await runDiscoOrderMigrations()
    const q = search ? `%${search.toLowerCase()}%` : null
    const rows = (await sql`
      SELECT c.email, c.first_name, c.last_name, c.phone, c.created_at, c.disabled_at,
             (SELECT MAX(o.created_at) FROM disco_orders o
               WHERE lower(o.customer_email) = lower(c.email) AND o.is_deleted = false) AS last_order
        FROM disco_customers c
       WHERE (c.fm_reference IS NULL OR c.fm_reference = '')
         AND (${q}::text IS NULL
              OR lower(c.email) LIKE ${q}
              OR lower(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE ${q})
       ORDER BY c.created_at DESC
       LIMIT 200
    `) as Array<{ email: string; first_name: string | null; last_name: string | null; phone: string | null; created_at: string | Date; disabled_at: string | Date | null; last_order: string | Date | null }>
    const iso = (v: string | Date | null) => v == null ? undefined : (v instanceof Date ? v.toISOString() : String(v))
    return rows.map(r => ({
      reference: `${DISCO_USER_PREFIX}${r.email}`,
      firstName: r.first_name || '',
      lastName: r.last_name || '',
      email: r.email,
      phoneNumber: r.phone || '',
      // The real column, not a constant — this toggle is enforced at login.
      enabled: !r.disabled_at,
      role: 'USER',
      createdDate: iso(r.created_at),
      lastOrder: iso(r.last_order),
      source: 'DISCO',
      native: true,
    }))
  } catch (e) {
    console.error('[admin/users] native users fetch failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  if (sp.get('search')) params.set('search', sp.get('search')!)
  if (sp.get('fromDate')) params.set('fromDate', sp.get('fromDate')!)
  if (sp.get('toDate')) params.set('toDate', sp.get('toDate')!)
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/admin/users?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch users' }, { status: res.status })
    const data = await res.json()

    // Prepend Disco-native accounts on the first page only — the same shape the
    // Orders list uses for native orders.
    if (!page || page === '0') {
      const native = await fetchNativeUsers((sp.get('search') || '').trim())
      if (native.length && data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).content)) {
        const d = data as Record<string, unknown>
        d.content = [...native, ...(d.content as unknown[])]
        if (typeof d.totalElements === 'number') d.totalElements += native.length
      }
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch users' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    // FM rejects formatted phones — digits only. Backstop for the admin UI.
    sanitizePhoneFields(body)
    const res = await fetch(`${FM}/api/admin/users`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create user', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create user' }, { status: 500 })
  }
}
