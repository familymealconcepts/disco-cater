import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'
import { getCustomerSession, getDiscoCustomer, getFmCustomerJwt } from '../../../lib/customer-auth'
import { sql } from '../../../lib/db'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Current customer profile. Disco-native session first (read from Neon); falls
// back to the legacy FM-JWT path during the transition.
export async function GET(req: NextRequest) {
  // 1) Disco session → read identity from disco_customers.
  try {
    const session = await getCustomerSession(req)
    if (session) {
      const c = await getDiscoCustomer(session.email).catch(() => null)
      return NextResponse.json({
        email: session.email,
        firstName: c?.first_name || session.firstName || '',
        lastName: c?.last_name || session.lastName || '',
        phoneNumber: c?.phone || '',
        role: 'USER',
        customerNumber: c?.fm_customer_number ?? null,
        reference: c?.fm_reference || session.fmReference || '',
      })
    }
  } catch (err) {
    console.error('[fm-user] disco session read failed:', err instanceof Error ? err.message : err)
  }

  // 2) Legacy fallback — FM JWT in disco_token.
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const res = await fetch(`${FM_API}/api/users`, { headers: { Authorization: token, Accept: 'application/json' } })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch profile' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('[fm-user] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const token = await getFmCustomerJwt(req)
  if (!token) return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })
  try {
    const body = await req.json()

    const res = await fetch(`${FM_API}/api/users`, {
      method: 'PUT',
      headers: { Authorization: token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to update profile' }, { status: res.status })
    const data = await res.json()

    // Best-effort: keep the Neon profile in sync with edited name/phone.
    try {
      const session = await getCustomerSession(req)
      if (session) {
        await sql`
          UPDATE disco_customers SET
            first_name = COALESCE(NULLIF(${String(body?.firstName || '')}, ''), first_name),
            last_name = COALESCE(NULLIF(${String(body?.lastName || '')}, ''), last_name),
            phone = COALESCE(NULLIF(${String(body?.phoneNumber || '')}, ''), phone),
            updated_at = NOW()
          WHERE email = ${session.email}
        `
      }
    } catch { /* best-effort sync */ }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[fm-user] PUT error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
