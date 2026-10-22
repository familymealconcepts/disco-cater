import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'
import { getCustomerSession, getDiscoCustomer } from '../../../lib/customer-auth'
import { sanitizePhone } from '../../../lib/utils/phone'
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
        companyName: c?.company_name || '',
      })
    }
  } catch (err) {
    console.error('[fm-user] disco session read failed:', err instanceof Error ? err.message : err)
  }

  // 2) Legacy fallback — FM JWT in disco_token. READ-ONLY: see PUT below.
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Please sign in or create an account to continue.' }, { status: 401 })
  try {
    const res = await fetch(`${FM_API}/api/users`, { headers: { Authorization: token, Accept: 'application/json' } })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch profile' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('[fm-user] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

// Profile save, from /account/profile.
//
// DISCO ONLY. This used to require an FM JWT and proxy FM's PUT /api/users,
// writing disco_customers only as a best-effort afterthought. Diners now sign up
// Disco-only (app/api/auth/signup creates no FamilyMeal account), so they have
// no FM JWT and every save failed with "Failed to save profile".
//
// disco_customers is the diner's profile of record: GET above reads it, login
// returns it, and checkout pre-fills from it. So the save writes there and
// NOWHERE ELSE: never to FamilyMeal (CLAUDE.md, never write to FM). A diner who
// also has a FamilyMeal account keeps whatever FM holds; FM's copy signs nothing
// in Disco, the same way change-password already treats the password.
//
// A legacy diner holding only the FM cookie (no Disco session, so no
// disco_customers row to update) is read-only here: GET still serves their FM
// profile, and PUT asks them to sign in again. Signing in through /api/fm-auth
// creates their Disco row, after which saving works.
//
// Email is NOT editable here: it is the account key (sessions, saved cards,
// favorites and orders are all keyed on it) and changing it needs a
// verification step that does not exist yet. The page renders it read-only; a
// body that tries to change it is refused rather than silently ignored.
export async function PUT(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  const session = await getCustomerSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Please sign out and sign in again to edit your profile.' }, { status: 401 })
  }

  const firstName = String(body?.firstName ?? '').trim()
  const lastName = String(body?.lastName ?? '').trim()
  if (!firstName || !lastName) {
    return NextResponse.json({ error: 'First and last name are required.' }, { status: 400 })
  }
  if (firstName.length > 100 || lastName.length > 100) {
    return NextResponse.json({ error: 'Names must be 100 characters or fewer.' }, { status: 400 })
  }

  if (body?.email !== undefined && String(body.email).trim().toLowerCase() !== session.email.toLowerCase()) {
    return NextResponse.json({ error: "Your email address can't be changed here. Please contact support to change it." }, { status: 400 })
  }

  // Phone: optional and clearable. Stored digits-only, the shape every
  // downstream consumer (checkout, FM order DTOs) already needs.
  const phoneProvided = body?.phoneNumber !== undefined
  const phoneDigits = sanitizePhone(String(body?.phoneNumber ?? ''))
  if (phoneProvided && phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
    return NextResponse.json({ error: 'Please enter a valid phone number, like (555) 555-5555.' }, { status: 400 })
  }

  // Company name is optional/clearable: only touched when the caller actually
  // sent the field (undefined = leave as-is; '' = clear).
  const companyProvided = body?.companyName !== undefined
  const company = companyProvided ? (String(body.companyName ?? '').trim().slice(0, 200) || null) : null

  try {
    const rows = (await sql`
      UPDATE disco_customers SET
        first_name = ${firstName},
        last_name = ${lastName},
        phone = CASE WHEN ${phoneProvided} THEN ${phoneDigits || null} ELSE phone END,
        company_name = CASE WHEN ${companyProvided} THEN ${company} ELSE company_name END,
        updated_at = NOW()
      WHERE email = ${session.email}
      RETURNING email, first_name, last_name, phone, company_name, fm_customer_number, fm_reference
    `) as Array<{
      email: string; first_name: string; last_name: string; phone: string | null
      company_name: string | null; fm_customer_number: number | null; fm_reference: string | null
    }>
    const c = rows[0]
    if (!c) return NextResponse.json({ error: 'Please sign out and sign in again to edit your profile.' }, { status: 401 })
    // Same shape GET returns, so the client can use either interchangeably.
    return NextResponse.json({
      email: c.email,
      firstName: c.first_name || '',
      lastName: c.last_name || '',
      phoneNumber: c.phone || '',
      role: 'USER',
      customerNumber: c.fm_customer_number ?? null,
      reference: c.fm_reference || session.fmReference || '',
      companyName: c.company_name || '',
    })
  } catch (err) {
    console.error('[fm-user] PUT error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to save your profile. Please try again.' }, { status: 500 })
  }
}
