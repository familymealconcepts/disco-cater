import { sql, runMigrations, runDiscoOrderMigrations } from './db'

// Archive / restore for Disco-native restaurants only. FM-backed archiving is
// deferred (see app/api/admin/restaurants/[ref]/route.ts's DELETE handler) —
// FM's block endpoint has never been confirmed to actually stop FM's own
// checkout, so claiming an FM-backed restaurant is "removed from the internet"
// would not be verifiable from this repo.
//
// NO rows are ever deleted. Archiving only sets archived_at across the three
// restaurant identity tables (disco_restaurant_overrides — canonical,
// disco_restaurant_cache, disco_restaurant_accounts), so every referenced row —
// orders, payments, menus, modifiers, the Stripe connected-account id — is left
// completely intact and the restaurant is fully restorable. This REPLACES the
// old hard delete (lib/disco-restaurant-delete.ts) for native restaurants, which
// deleted rows across every table with a restaurant_reference column with no way
// back — exactly the failure mode this exists to eliminate.
//
// archived_at is deliberately distinct from `visible`/`is_live`/
// `online_ordering_enabled`: it is a fourth, STRONGER gate, checked first
// everywhere those three are checked (see the discovery-filter helper,
// getDiscoGroupAccounts, the login routes, and getAccountByInviteToken).
// Archiving never sets or clears those three flags as a side effect — doing so
// would make restore ambiguous about whether `visible` was false before
// archiving or because of it.
//
// The three writes happen in one transaction: a restaurant half-archived by a
// failure partway through (e.g. cache updated but overrides not) would be
// visibly inconsistent across surfaces that check different tables.

// Appended to the marketplace-cache name on archive (reversible on restore), so
// an archived restaurant reads clearly as archived in any admin list and its
// name is free for a new restaurant to reuse. Disco-native slugs already embed
// the restaurant reference, so there is no slug/name UNIQUE constraint this
// dodges — the suffix is purely for admin-list clarity.
export const NATIVE_ARCHIVED_NAME_SUFFIX = ' [Archived]'

async function ensureArchiveColumns(): Promise<void> {
  // archived_at/archived_by live in two different migration suites (overrides +
  // cache in runMigrations, accounts in runDiscoOrderMigrations) — both are
  // idempotent and cached per-lambda, so running both here is cheap after the
  // first call.
  await Promise.all([runMigrations(), runDiscoOrderMigrations()])
}

export async function archiveDiscoNativeRestaurant(
  ref: string,
  actorEmail: string | null,
): Promise<void> {
  if (!ref) throw new Error('archiveDiscoNativeRestaurant: missing ref')
  await ensureArchiveColumns()

  await sql.transaction([
    // Canonical flag (create the row if a native restaurant somehow never got one).
    sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, archived_at, archived_by)
      VALUES (${ref}, NOW(), ${actorEmail ?? null})
      ON CONFLICT (restaurant_reference)
      DO UPDATE SET archived_at = NOW(), archived_by = ${actorEmail ?? null}, updated_at = NOW()
    `,
    // Mirror onto the marketplace snapshot + free the name for reuse.
    sql`
      UPDATE disco_restaurant_cache
      SET archived_at = NOW(),
          name = CASE WHEN name LIKE ${'%' + NATIVE_ARCHIVED_NAME_SUFFIX}
                      THEN name ELSE name || ${NATIVE_ARCHIVED_NAME_SUFFIX} END
      WHERE restaurant_reference = ${ref}
    `,
    // Mirror onto the identity/login table (account + its stripe_account_id are
    // preserved — see the "MUST NOT TOUCH" comment on the login routes for why
    // nothing here touches Stripe).
    sql`UPDATE disco_restaurant_accounts SET archived_at = NOW() WHERE restaurant_reference = ${ref}`,
    // Revoke any pending invite so an already-issued token can't be accepted
    // after archiving. Restore does NOT resurrect it — a restored restaurant's
    // admin gets a fresh invite sent, not an old one un-expired.
    sql`
      UPDATE disco_restaurant_accounts
      SET invite_token = NULL, invite_token_expires_at = NULL
      WHERE restaurant_reference = ${ref} AND invite_token IS NOT NULL
    `,
  ])
}

export async function restoreDiscoNativeRestaurant(ref: string): Promise<void> {
  if (!ref) throw new Error('restoreDiscoNativeRestaurant: missing ref')
  await ensureArchiveColumns()

  await sql.transaction([
    sql`
      UPDATE disco_restaurant_overrides
      SET archived_at = NULL, archived_by = NULL, updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `,
    sql`
      UPDATE disco_restaurant_cache
      SET archived_at = NULL,
          name = regexp_replace(name, '( \\[Archived\\])+$', '')
      WHERE restaurant_reference = ${ref}
    `,
    sql`UPDATE disco_restaurant_accounts SET archived_at = NULL WHERE restaurant_reference = ${ref}`,
  ])
}
