import { sql, withDiscoTables, runCheckoutContactsMigrations } from './db'

// Abandoned-checkout contact capture -- writer for disco_checkout_contacts (see
// lib/migrations/006_checkout_contacts.sql for why this is its own table and how
// long it is kept). Nothing here sends anything to anyone.
//
// Like recordFunnelStage, these functions can throw on a real DB error and do
// NOT swallow it themselves: the swallowing lives at the call sites
// (/api/checkout-contact, /api/order/place), each of which is best-effort and
// must never let a capture failure touch a customer's checkout.

// Generous caps -- these exist to stop a junk/oversized body being stored, not to
// validate real input (FM and the drawer do that). Anything longer is cut, not
// rejected: a truncated value is still a usable lead, a rejection is a lost one.
export const CHECKOUT_CONTACT_LIMITS = {
  name: 100,
  email: 254, // RFC 5321 path limit
  phone: 32,
  company: 200,
} as const

export interface CheckoutContactInput {
  sessionId: string
  restaurantReference: string
  // From the server-side customer session ONLY -- never from a request body.
  accountEmail: string
  accountFirstName: string | null
  accountLastName: string | null
  // As typed in the checkout drawer.
  contactFirstName: string | null
  contactLastName: string | null
  contactEmail: string | null
  contactPhone: string | null
  contactCompany: string | null
}

// Upsert keyed on the funnel session id. A re-capture (the diner edits a field)
// refreshes the typed fields, the account (whoever is signed in NOW -- a row must
// never pair one account with another account's typed details) and updated_at.
// contact_entered_at is first-capture only. order_placed_at is never touched here.
export async function upsertCheckoutContact(input: CheckoutContactInput): Promise<void> {
  if (!input.sessionId || !input.restaurantReference || !input.accountEmail) return
  await withDiscoTables(
    () => sql`
      INSERT INTO disco_checkout_contacts (
        session_id, restaurant_reference, account_email, account_first_name, account_last_name,
        contact_first_name, contact_last_name, contact_email, contact_phone, contact_company,
        contact_entered_at, created_at, updated_at
      ) VALUES (
        ${input.sessionId}, ${input.restaurantReference}, ${input.accountEmail}, ${input.accountFirstName}, ${input.accountLastName},
        ${input.contactFirstName}, ${input.contactLastName}, ${input.contactEmail}, ${input.contactPhone}, ${input.contactCompany},
        NOW(), NOW(), NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        account_email = EXCLUDED.account_email,
        account_first_name = EXCLUDED.account_first_name,
        account_last_name = EXCLUDED.account_last_name,
        contact_first_name = EXCLUDED.contact_first_name,
        contact_last_name = EXCLUDED.contact_last_name,
        contact_email = EXCLUDED.contact_email,
        contact_phone = EXCLUDED.contact_phone,
        contact_company = EXCLUDED.contact_company,
        updated_at = NOW()
    `,
    runCheckoutContactsMigrations,
  )
}

// Marks a session's contact row as converted. Called from /api/order/place right
// where ORDER_PLACED is recorded, keyed by the same funnel session id. Matches
// zero rows -- and is a silent no-op -- when no contact was ever captured for the
// session (signed-out checkout, missing cookie, earlier capture failure).
// Idempotent (COALESCE keeps the first stamp), so withDiscoTables' retry-after-
// migrate is safe. Also scoped to the restaurant, so a session id from one
// restaurant's place call can never stamp another restaurant's row.
export async function stampCheckoutContactOrderPlaced(sessionId: string, restaurantReference: string): Promise<void> {
  if (!sessionId || !restaurantReference) return
  await withDiscoTables(
    () => sql`
      UPDATE disco_checkout_contacts
      SET order_placed_at = COALESCE(order_placed_at, NOW()), updated_at = NOW()
      WHERE session_id = ${sessionId} AND restaurant_reference = ${restaurantReference}
    `,
    runCheckoutContactsMigrations,
  )
}
