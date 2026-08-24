import { sql, runMigrations, withDiscoTables } from './db'

// The single place that answers "may this restaurant accept an online order
// right now". Sits alongside the other shared predicates (stripe-readiness.ts,
// marketplace-restaurants.ts, marketplace-visibility.ts) for the same reason
// they were extracted: the marketplace visibility clause was independently
// pasted into 5 places, and every flag change then had to be applied 5 times —
// which is exactly how archived_at came to be missing from some of them. The
// ordering path had NO gate at all before this, so there is nothing to
// de-duplicate yet; this exists so there never is.
//
// READ-ONLY, DELIBERATELY. This module never writes. In particular it must
// never write online_ordering_enabled, visible or is_live: if one of those is
// set, a human set it on purpose, and an archive/restore cycle that mutated
// them would come back with the wrong state and no way to tell what it had
// been. Archive is expressed solely by archived_at, and suppression of
// ordering is therefore a READ-TIME decision evaluated here.
//
// ── WHY THE RULE DIFFERS BY RESTAURANT TYPE ────────────────────────────────
// The marketplace feed applies a 2-part rule to FM-backed rows and a 3-part
// rule to Disco-native rows (lib/marketplace-restaurants.ts). Ordering is not
// the same question as listing, so this is not a copy of that rule — but the
// reason its shape differs by type is the same, and it is measured, not
// assumed. Counted live in production:
//
//   online_ordering_enabled, FM-backed : 3,898 false / 137 true / 4 null
//   online_ordering_enabled, native    :     0 false /  44 true / 4 null
//
// FM-backed restaurants take the overwhelming majority of real orders, so that
// 3,898 is not 3,898 restaurants with ordering switched off — it is a stale
// Neon default that never tracked FM's own state (the FM online-ordering
// mirror is a known outstanding follow-up, documented in
// marketplace-restaurants.ts). Applying the native rule to FM-backed rows
// would refuse orders for 3,898 restaurants that are ordering perfectly well
// today. So online_ordering_enabled gates NATIVE ONLY.
//
// ── FLAGS DELIBERATELY NOT GATED ───────────────────────────────────────────
// visible — marketplace listing, not ordering. 2 native restaurants have taken
//   real orders while visible = false; a restaurant can be deliberately
//   unlisted and still sell through a direct link, and gating this would break
//   that.
// is_live — unmaintained for FM-backed rows. 133 FM-backed restaurants have
//   taken real orders while is_live = false. Same conclusion the marketplace
//   feed reached for the same reason.
// stripe_connected — a payment problem, not an eligibility problem. It fails
//   at the charge with a message about payment, which is more useful to a
//   customer than a generic "cannot order" up front.
//
// Archive is Disco-native only (lib/disco-restaurant-archive.ts): FM-backed
// rows never get archived_at set, so the archive branch is a harmless no-op
// for them rather than a special case. FM's own `blocked` flag is never
// written from here — FM couples blocked to onlineOrderingAllowed
// bidirectionally, so writing it would mutate FM's ordering state as a side
// effect.

export type OrderableReason =
  | 'ok'
  // Disco-native and archived. The strongest gate; short-circuits everything.
  | 'archived'
  // Disco-native with online ordering explicitly switched off.
  | 'ordering-disabled'
  // No cache row for this reference at all. Treated as NOT orderable: an
  // unknown restaurant is not a restaurant we can take money on behalf of.
  | 'unknown-restaurant'

export interface OrderableResult {
  orderable: boolean
  reason: OrderableReason
  /** Customer-facing, safe to surface directly. */
  message: string
}

const MESSAGES: Record<OrderableReason, string> = {
  ok: '',
  archived: 'This restaurant is no longer available on Disco Cater.',
  'ordering-disabled': 'This restaurant is not accepting online orders right now.',
  'unknown-restaurant': 'We could not find this restaurant.',
}

function result(reason: OrderableReason): OrderableResult {
  return { orderable: reason === 'ok', reason, message: MESSAGES[reason] }
}

interface OrderableState {
  isDiscoNative: boolean
  archived: boolean
  onlineOrderingEnabled: boolean | null
}

// ONE read, shared by both policies below, so there is a single place that
// knows which columns matter and no clause is written twice.
async function readOrderableState(ref: string): Promise<OrderableState | null> {
  const rows = (await withDiscoTables(() => sql`
    SELECT COALESCE(c.is_disco_native, false) AS is_disco_native,
           (o.archived_at IS NOT NULL) AS archived,
           o.online_ordering_enabled
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE c.restaurant_reference = ${ref}
    LIMIT 1
  `, runMigrations)) as {
    is_disco_native: boolean
    archived: boolean
    online_ordering_enabled: boolean | null
  }[]

  const r = rows[0]
  if (!r) return null
  return {
    isDiscoNative: r.is_disco_native,
    archived: r.archived,
    onlineOrderingEnabled: r.online_ordering_enabled,
  }
}

/**
 * CUSTOMER-FACING ONLINE ORDERING. Read-only. Never throws for an ordinary
 * "not orderable" outcome — callers branch on `orderable`. A genuine
 * infrastructure failure (Neon unreachable) does throw, and callers should let
 * that surface as a 500 rather than silently allowing the order: failing
 * closed is the safer default for a gate whose whole job is to refuse.
 */
export async function assertRestaurantOrderable(ref: string): Promise<OrderableResult> {
  if (!ref) return result('unknown-restaurant')
  const s = await readOrderableState(ref)
  if (!s) return result('unknown-restaurant')

  // Archive first — it must never be reachable around by the flag below.
  if (s.archived) return result('archived')

  // Native only; see the measured reasoning in the header.
  if (s.isDiscoNative && s.onlineOrderingEnabled === false) {
    return result('ordering-disabled')
  }

  return result('ok')
}

/**
 * STAFF DIRECT ENTRY from the restaurant portal — a deliberately DIFFERENT
 * policy over the same read, not a second copy of the rule.
 *
 * online_ordering_enabled governs ONLINE ordering: a restaurant that switches
 * it off is closing the public web checkout, not telling its own staff to stop
 * keying in phone and walk-in orders. Gating direct entry on it would break
 * that workflow, so this policy ignores it.
 *
 * Archive is different in kind and still blocks: an archived restaurant is
 * withdrawn from the platform entirely, and its portal login is revoked
 * anyway, so a direct-entry order against one is never intended.
 */
export async function assertRestaurantAcceptsDirectEntry(ref: string): Promise<OrderableResult> {
  if (!ref) return result('unknown-restaurant')
  const s = await readOrderableState(ref)
  if (!s) return result('unknown-restaurant')
  if (s.archived) return result('archived')
  return result('ok')
}

/**
 * HTTP shape for the gate, so the ~5 call sites don't each invent their own
 * status code and body. 409 rather than 403: the caller is authenticated and
 * permitted, the restaurant's state is what conflicts.
 */
export function orderableErrorBody(r: OrderableResult): { body: { error: string; reason: OrderableReason }; status: number } {
  return {
    body: { error: r.message, reason: r.reason },
    status: r.reason === 'unknown-restaurant' ? 404 : 409,
  }
}
