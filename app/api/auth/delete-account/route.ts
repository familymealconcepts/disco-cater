import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS, getToken } from '../../../../lib/auth'
import { sql } from '../../../../lib/db'
import { ensureAuditTable } from '../../../../lib/admin-audit'
import { verifiedFmClaims } from '../../../../lib/fm-token-verify'
import {
  CUSTOMER_COOKIE, CUSTOMER_COOKIE_OPTS, FM_MIGRATED,
  getCustomerSession, getDiscoCustomer, verifyCustomerPassword, fmLogin,
} from '../../../../lib/customer-auth'

export const runtime = 'nodejs'

// Diner self-service account deletion, from /account/security.
//
// ── WHY THIS DID NOTHING ────────────────────────────────────────────────────
// It was a stub keyed on the legacy FM cookie (disco_token): it logged a
// "please action manually" line and returned success. Diners now sign up
// Disco-only and carry no FM cookie, so it 401'd, and the page swallowed the
// 401 with the dialog still open.
//
// ── WHAT IT DOES NOW ────────────────────────────────────────────────────────
// Requires the signed-in Disco session AND the account password, then deletes
// the diner's Disco account in ONE data-modifying statement (neon HTTP has no
// interactive transactions — see CLAUDE.md — and a single statement is atomic,
// so a half-deleted account cannot happen). Every sub-delete is gated on the
// disco_customers row actually being deleted in that same statement.
//
// DELETED (the diner's own data, keyed on their email / customer reference):
//   disco_customers                   the account row (incl. password hash,
//                                     reset token, profile, stripe_customer_id)
//   disco_customer_sessions           every session, on every device
//   customer_addresses                saved delivery addresses
//   disco_customer_payment_methods    saved-card REFERENCES (Stripe ids + last4)
//   disco_customer_favorites          favourited restaurants
//   disco_checkout_contacts           checkout contact captures (abandoned-cart
//                                     funnel rows; nothing reads them, 30-day
//                                     retention anyway)
// CANCELED, not deleted (so no future charge can run):
//   recurring_orders                  status -> CANCELED (the charge cron only
//                                     acts on status = 'ACTIVE')
//   recurring_order_occurrences       every not-yet-charged occurrence ->
//                                     CANCELED. PLACED / SKIPPED / already
//                                     CANCELED / mid-charge rows are history and
//                                     are left as they are.
// KEPT, deliberately untouched:
//   disco_orders (+ items, events, payments, sale transactions),
//   fm_historical_orders              financial records; each order carries
//                                     its own copy of the contact details
//   promo_code_uses                   redemption history (per-user limits)
//   marketing_email_opt_outs          an opt-out must outlive the account, or a
//                                     later import could email them again
//   marketing_send_log                send history
//   disco_customer_roster, fm_customers  FamilyMeal-sourced mirrors, not
//                                     Disco account data
//   disco_admin_audit                 gains one 'customer_account_deleted' row
//
// NOT CALLED: Stripe (the saved cards stay on the platform Stripe customer and
// can no longer be reached from Disco once the references are gone) and
// FamilyMeal. If this diner also has a FamilyMeal account, that account is
// FamilyMeal's and is untouched — Disco never writes to FM (CLAUDE.md). Note
// that signing in again with valid FamilyMeal credentials would re-create a
// Disco account from FM, exactly as it does for any FM diner today.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body → no password → refused below */ }
  const password = String(body?.password ?? '')

  const session = await getCustomerSession(req)
  if (!session) {
    // Legacy diner holding only the FamilyMeal cookie: there is no Disco
    // account to delete, and Disco cannot delete a FamilyMeal account.
    const fmToken = getToken(req)
    const claims = fmToken ? await verifiedFmClaims(fmToken) : null
    if (claims) {
      const email = String(claims.email || claims.sub || 'unknown')
      console.warn(`[account-deletion] FM-only diner ${email} asked to delete their account — no Disco account exists; pointed to support.`)
      return NextResponse.json({
        error: 'Your account is managed by FamilyMeal, so it can’t be deleted here. Please email concierge@discocater.com and we’ll take care of it.',
      }, { status: 409 })
    }
    return NextResponse.json({ error: 'Please sign in again to delete your account.' }, { status: 401 })
  }

  if (!password) {
    return NextResponse.json({ error: 'Please enter your password to confirm.' }, { status: 400 })
  }

  const customer = await getDiscoCustomer(session.email).catch(() => null)
  if (!customer) return NextResponse.json({ error: 'Please sign in again to delete your account.' }, { status: 401 })

  // Same two-branch verification as login and change-password: a customer still
  // on the FM_MIGRATED sentinel has no Disco hash yet, so their password is
  // checked with an FM LOGIN (a read — it changes nothing at FamilyMeal).
  const ok = customer.password_hash === FM_MIGRATED
    ? !!(await fmLogin(session.email, password))
    : await verifyCustomerPassword(password, customer.password_hash)
  if (!ok) return NextResponse.json({ error: 'That password is incorrect.' }, { status: 400 })

  const email = customer.email.toLowerCase()
  // Addresses and recurring orders are keyed on customer_fm_reference, which is
  // the FM reference when the diner has one and their email when not
  // (lib/recurring.ts getCustomer). Match both.
  const refs = Array.from(new Set([email, customer.email, customer.fm_reference || ''].filter(Boolean)))

  try {
    await ensureAuditTable()
    const rows = (await sql`
      WITH del_customer AS (
        DELETE FROM disco_customers WHERE id = ${customer.id} AND lower(email) = ${email}
        RETURNING id
      ),
      del_sessions AS (
        DELETE FROM disco_customer_sessions
        WHERE lower(customer_email) = ${email} AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      del_addresses AS (
        DELETE FROM customer_addresses
        WHERE (lower(customer_email) = ${email} OR customer_fm_reference = ANY(${refs}))
          AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      del_cards AS (
        DELETE FROM disco_customer_payment_methods
        WHERE lower(customer_email) = ${email} AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      del_favorites AS (
        DELETE FROM disco_customer_favorites
        WHERE lower(customer_email) = ${email} AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      del_checkout_contacts AS (
        DELETE FROM disco_checkout_contacts
        WHERE lower(account_email) = ${email} AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      owned_recurring AS (
        SELECT id FROM recurring_orders
        WHERE lower(customer_email) = ${email} OR customer_fm_reference = ANY(${refs})
      ),
      cancel_recurring AS (
        UPDATE recurring_orders SET status = 'CANCELED', updated_at = NOW()
        WHERE id IN (SELECT id FROM owned_recurring) AND status <> 'CANCELED'
          AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      cancel_occurrences AS (
        UPDATE recurring_order_occurrences
        SET status = 'CANCELED', canceled_at = NOW(),
            cancellation_reason = 'Customer deleted their account', updated_at = NOW()
        WHERE recurring_order_id IN (SELECT id FROM owned_recurring)
          AND status IN ('SCHEDULED', 'REMINDER_SENT', 'CHARGE_FAILED', 'PAYMENT_REMINDER_SENT')
          AND EXISTS (SELECT 1 FROM del_customer)
        RETURNING 1
      ),
      counts AS (
        SELECT
          (SELECT count(*) FROM del_customer)::int          AS customers,
          (SELECT count(*) FROM del_sessions)::int          AS sessions,
          (SELECT count(*) FROM del_addresses)::int         AS addresses,
          (SELECT count(*) FROM del_cards)::int             AS payment_methods,
          (SELECT count(*) FROM del_favorites)::int         AS favorites,
          (SELECT count(*) FROM del_checkout_contacts)::int AS checkout_contacts,
          (SELECT count(*) FROM cancel_recurring)::int      AS recurring_canceled,
          (SELECT count(*) FROM cancel_occurrences)::int    AS occurrences_canceled
      ),
      audit AS (
        INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
        SELECT 'customer_account_deleted', NULL, ${email},
               jsonb_build_object('customerId', ${customer.id}::int, 'source', 'self-service',
                                  'counts', to_jsonb(counts.*))
        FROM counts WHERE counts.customers = 1
        RETURNING id
      )
      SELECT counts.*, (SELECT id FROM audit) AS audit_id FROM counts
    `) as Array<{
      customers: number; sessions: number; addresses: number; payment_methods: number
      favorites: number; checkout_contacts: number; recurring_canceled: number
      occurrences_canceled: number; audit_id: number | null
    }>
    const r = rows[0]
    if (!r || r.customers !== 1) {
      console.error(`[account-deletion] customer id=${customer.id} was not deleted (row missing at write time)`)
      return NextResponse.json({ error: 'We couldn’t delete your account. Please try again.' }, { status: 500 })
    }

    // Log line: never includes the password.
    console.log(`[account-deletion] deleted diner id=${customer.id} email=${email} audit=${r.audit_id} ` +
      `sessions=${r.sessions} addresses=${r.addresses} cards=${r.payment_methods} favorites=${r.favorites} ` +
      `checkoutContacts=${r.checkout_contacts} recurringCanceled=${r.recurring_canceled} ` +
      `occurrencesCanceled=${r.occurrences_canceled} (orders kept)`)

    const resp = NextResponse.json({ success: true })
    resp.cookies.set(CUSTOMER_COOKIE, '', { ...CUSTOMER_COOKIE_OPTS, maxAge: 0 })
    resp.cookies.set('disco_token', '', { ...COOKIE_OPTS, maxAge: 0 })
    resp.cookies.set('disco_refresh', '', { ...COOKIE_OPTS, maxAge: 0 })
    return resp
  } catch (err) {
    console.error('[account-deletion] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'We couldn’t delete your account. Please try again.' }, { status: 500 })
  }
}
