import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../lib/customer-auth'
import { funnelCookieName } from '../../../lib/checkout-funnel-shared'
import { CHECKOUT_CONTACT_LIMITS, upsertCheckoutContact } from '../../../lib/checkout-contacts'

export const runtime = 'nodejs'

// Abandoned-checkout contact capture (see lib/migrations/006_checkout_contacts.sql).
// Posted fire-and-forget from CheckoutDrawer once the contact fields are filled,
// and again (debounced) when they change. Kept OFF /api/checkout-funnel/track on
// purpose: that route is anonymous and stores no PII, and widening it would put a
// name/email/phone behind a route that accepts anyone.
//
// What this route trusts, and what it does not:
//   * IDENTITY comes from the server-side customer session (getCustomerSession --
//     the same disco_customer_token lookup /api/fm-user and /api/order/place use).
//     No session -> no write. An email or name in the body is only ever stored as
//     the TYPED contact, never as the account.
//   * THE ROW KEY comes from the disco_fn_<ref> cookie, not from the body. Both are
//     client-controlled, so this is not about the cookie being unforgeable; it is
//     that the cookie is the one value that is, by construction, the id the funnel
//     row is keyed on (getOrCreateFunnelSessionId writes it, every stage reads it),
//     and that a body field would let any signed-in caller aim a write at an
//     arbitrary session id with one JSON edit. No cookie -> no write, rather than a
//     fallback to the body.
//   * The response is constant (204) whatever happens. Nothing on the client reads
//     it, and a constant answer tells a caller nothing about whether a session or
//     row exists.
//
// Best-effort: every failure is logged and swallowed. Checkout never waits on this.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_MAX = 200

function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function done() {
  return new NextResponse(null, { status: 204 })
}

export async function POST(req: NextRequest) {
  try {
    const session = await getCustomerSession(req)
    if (!session?.email) return done() // signed out (or legacy FM-only session): no write

    const body = await req.json().catch(() => null)
    const restaurantReference = clip(body?.restaurantReference, REF_MAX)
    if (!restaurantReference) return done()

    const sessionId = req.cookies.get(funnelCookieName(restaurantReference))?.value || ''
    if (!UUID_RE.test(sessionId)) return done() // no funnel session to attach to

    const L = CHECKOUT_CONTACT_LIMITS
    await upsertCheckoutContact({
      sessionId,
      restaurantReference,
      accountEmail: session.email,
      accountFirstName: session.firstName || null,
      accountLastName: session.lastName || null,
      contactFirstName: clip(body?.firstName, L.name),
      contactLastName: clip(body?.lastName, L.name),
      contactEmail: clip(body?.email, L.email),
      contactPhone: clip(body?.phone, L.phone),
      contactCompany: clip(body?.company, L.company),
    })
  } catch (e) {
    console.error('[checkout-contact] capture failed (non-fatal):', e instanceof Error ? e.message : e)
  }
  return done()
}
