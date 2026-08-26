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
// stripe_connected — NOT gated, and that is still right, but the reasoning
//   below it used to be wrong in a way that mattered. It said a Stripe problem
//   "fails at the charge with a message about payment". That is true on the FM
//   path, where FM's backend returns 401 when the connected account cannot take
//   a charge. It is FALSE on the native path: createNativeOrderPaymentIntent
//   computes `routeToRestaurant = !withholdPayouts && !!connectedAccountId` and,
//   when false, simply OMITS transfer_data — so the charge SUCCEEDS and the
//   whole amount settles into Disco's platform account with the restaurant
//   unpaid. Nothing fails and nobody is told.
//
//   stripe_connected itself stays ungated because it is a stale readiness flag,
//   not a statement about the account: Test 50 has stripe_connected = false and
//   a real, verified linked account (its native orders' PaymentIntents settle to
//   acct_1Tx5EOKZCiY7GPJW). Gating on it would refuse a restaurant that is
//   correctly configured. What IS gated, for native only, is the absence of
//   stripe_account_id — see 'payment-not-configured'.
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
  // Disco-native with NO Stripe connected account on file.
  //
  // A MISCONFIGURATION, not a policy choice, and the distinction is the whole
  // reason this reason exists. The payment layer collapses two very different
  // situations into one behaviour — omit transfer_data — and only one of them
  // is deliberate:
  //   withhold_payouts = true  → an admin decided the platform holds the money.
  //   connectedAccountId null  → nobody decided anything; it is simply missing.
  // The second must refuse rather than charge. The first is untouched here.
  //
  // Measured before writing this: across every native order that has ever
  // reached Stripe (29 PaymentIntents, 25 succeeded, live mode), ALL 25 carried
  // transfer_data. The platform-only branch has never once fired in production,
  // for either reason — so this gate changes no behaviour that has ever
  // actually happened, and the withhold branch remains unexercised and
  // deliberately unmodified.
  | 'payment-not-configured'
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
  'payment-not-configured': 'This restaurant is not set up to take online payments yet. Please contact them directly to place an order.',
  'unknown-restaurant': 'We could not find this restaurant.',
}

function result(reason: OrderableReason): OrderableResult {
  return { orderable: reason === 'ok', reason, message: MESSAGES[reason] }
}

interface OrderableState {
  isDiscoNative: boolean
  archived: boolean
  onlineOrderingEnabled: boolean | null
  /** disco_restaurant_overrides.stripe_account_id — the connected account the
   *  native payment path routes funds to. NOT stripe_connected, which is a
   *  stale readiness flag; see the header. */
  stripeAccountId: string | null
}

// ONE read, shared by both policies below, so there is a single place that
// knows which columns matter and no clause is written twice.
async function readOrderableState(ref: string): Promise<OrderableState | null> {
  const rows = (await withDiscoTables(() => sql`
    SELECT COALESCE(c.is_disco_native, false) AS is_disco_native,
           (o.archived_at IS NOT NULL) AS archived,
           o.online_ordering_enabled,
           o.stripe_account_id
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE c.restaurant_reference = ${ref}
    LIMIT 1
  `, runMigrations)) as {
    is_disco_native: boolean
    archived: boolean
    online_ordering_enabled: boolean | null
    stripe_account_id: string | null
  }[]

  const r = rows[0]
  if (!r) return null
  return {
    isDiscoNative: r.is_disco_native,
    archived: r.archived,
    onlineOrderingEnabled: r.online_ordering_enabled,
    stripeAccountId: r.stripe_account_id,
  }
}

// Shared by both policies. NATIVE ONLY: an FM-backed restaurant's money runs
// through FM's own Stripe integration and never touches
// createNativeOrderPaymentIntent, so this must not refuse the ~4,000 FM rows —
// most of which have no stripe_account_id in Neon and are ordering perfectly
// well today.
function nativePaymentUnconfigured(s: OrderableState): boolean {
  return s.isDiscoNative && !s.stripeAccountId
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

  // Native with no connected account: refuse BEFORE the customer reaches
  // payment. Without this the charge succeeds platform-only and silently.
  if (nativePaymentUnconfigured(s)) return result('payment-not-configured')

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
  // Gated here TOO, unlike online_ordering_enabled. That flag is about which
  // channel is open; this one is about whether the money can reach the
  // restaurant at all, and a direct-entry order charges a real card exactly the
  // same way a web order does. This path uses its own policy function rather
  // than the customer gate, so it would otherwise be an unguarded route to the
  // same PaymentIntent.
  if (nativePaymentUnconfigured(s)) return result('payment-not-configured')
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
