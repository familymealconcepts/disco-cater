import { sql, runMigrations, withDiscoTables } from './db'
import { formatDisplayAddress, dedupeAddressString } from './address-display'

export interface MarketplaceRestaurantRow {
  reference: string
  name: string
  slug: string | null
  cuisine: string | null
  description: string | null
  imageUrl: string | null
  lat: string | null
  lng: string | null
  location: string | null
  address: string | null
  isDiscoNative: boolean | null
  isPremium: boolean | null
  orderUrl: string | null
  featuredOrder: number | null
}

// The single source of truth for "does this restaurant appear on the public
// marketplace" — the fullmap feed, city pages, the /restaurants directory, and
// the sitemap all call this rather than each declaring their own copy of the
// same WHERE clause (which is how it was before this was extracted: the
// identical clause was independently pasted in all 4 places). The next flag
// change only needs to touch this file.
//
// VISIBILITY:
//   • is_test is excluded unconditionally (see the WHERE clause and
//     lib/marketplace-switch.ts). It is a veto, not a fourth concept: a test
//     account is not a restaurant a customer should ever be shown.
//   • archived_at IS NULL is checked FIRST and short-circuits everything below
//     it — archive is a fourth, STRONGER gate than visible/stripe_connected/
//     online_ordering_enabled, and must never be reachable around by them. See
//     lib/disco-restaurant-archive.ts for why archiving never sets those three
//     flags as a side effect (restore would become ambiguous about whether
//     `visible` was false before archiving or because of it).
//   • FM-backed: marketplace toggle ON (o.visible) AND Stripe connected
//     (o.stripe_connected). Online-ordering is NOT gated here — the Neon
//     online_ordering_enabled column is a stale default for FM-backed
//     restaurants and doesn't reflect FM's real state (a real FM
//     online-ordering mirror is a tracked follow-up).
//   • Disco-native: FULL 3-part rule — marketplace toggle ON (o.visible) AND
//     online ordering ON (COALESCE(o.online_ordering_enabled,true)) AND a Disco
//     connected account on file (o.stripe_account_id, or one attached to the
//     account row during onboarding). NOT o.stripe_connected — see the comment
//     on that branch below.
//
// THERE ARE EXACTLY THREE CONCEPTS, AND THIS FILTER IS THE THIRD:
//   Stripe connection — enables online ordering; without it a restaurant
//                       cannot take payment
//   Online ordering   — a toggle, on automatically for a newly Stripe-connected
//                       location, controllable by admins, system admins and
//                       super admins
//   Map               — default on; makes the restaurant visible here
// Nothing else gates visibility or ordering.
//
// This filter never read is_live, which is why it was already correct when
// is_live was removed as a gate everywhere else. Do not reintroduce it: it is
// not a concept. (It was also never maintained — 3,770 of 4,051 FM-backed rows
// sat at false purely because the cache cron never set it, so reading it here
// would have dropped ~95 real, Stripe-connected restaurants off the feed.)
export async function getMarketplaceRestaurants(): Promise<MarketplaceRestaurantRow[]> {
  const rows = (await withDiscoTables(() => sql`
    SELECT c.restaurant_reference, c.name, c.slug, c.cuisine, c.description,
           COALESCE(c.image_url, c.icon_url) AS image_url,
           c.lat, c.lng, c.location, c.address, c.is_disco_native,
           c.address_line1, c.address_line2, c.city, c.state, c.zipcode,
           o.is_premium, o.order_url, o.featured_order
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    LEFT JOIN LATERAL (
      SELECT a2.stripe_account_id, a2.stripe_onboarding_complete
      FROM disco_restaurant_accounts a2
      WHERE (a2.restaurant_reference = c.restaurant_reference OR a2.fm_restaurant_reference = c.restaurant_reference)
        AND a2.stripe_account_id IS NOT NULL
      ORDER BY a2.stripe_onboarding_complete DESC NULLS LAST, a2.id ASC
      LIMIT 1
    ) a ON true
    WHERE
      o.archived_at IS NULL
      -- TEST ACCOUNTS NEVER LIST. lib/marketplace-switch.ts already refuses to
      -- turn a test restaurant's switch on; this is the last line, so a missed
      -- or future write path — or a row that was visible before it was flagged —
      -- still cannot reach the feed, city pages, directory or sitemap.
      AND o.is_test IS NOT TRUE
      AND (
        (COALESCE(c.is_disco_native, false) = false
          AND o.visible = true AND o.stripe_connected = true)
        OR
        -- ── NATIVE: THE SAME ACCOUNT CHECKOUT REQUIRES ─────────────────────
        -- o.stripe_connected is NOT a payout signal for a native restaurant. It
        -- is set by probing FamilyMeal's /api/stripe/{ref} and answers "does
        -- FamilyMeal hold an account", which is the right question for the
        -- FM-backed branch above and the wrong one here: Disco charges the card
        -- itself and needs its OWN connected account.
        --
        -- Listing on that flag put 122 native restaurants on the marketplace
        -- that refuse every order at checkout — findable, orderable, and
        -- failing on the payment step. The customer gate
        -- (lib/restaurant-orderable.ts) reads disco_restaurant_overrides
        -- .stripe_account_id, so this now reads exactly the same column: a
        -- restaurant appears on the marketplace only if it can actually take
        -- the order it would receive.
        --
        -- The accounts-table bridge stays for restaurants whose account was
        -- attached there during onboarding rather than onto overrides.
        (c.is_disco_native = true
          AND o.visible = true
          AND COALESCE(o.online_ordering_enabled, true) = true
          AND (o.stripe_account_id IS NOT NULL
               OR (a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true))
          -- AND STRIPE WILL ACTUALLY TAKE THE CHARGE. A restricted account is
          -- CONNECTED (so the portal says "Restricted" rather than the useless
          -- "Not connected") but cannot be paid, so the restaurant does not
          -- belong on the marketplace. NULL is left alone deliberately: a
          -- snapshot not yet taken is unknown, not broken, and refusing on
          -- unknown would unlist every restaurant linked between two runs of
          -- cron/refresh-stripe-capabilities.
          AND COALESCE(o.stripe_charges_enabled, true) = true
          AND COALESCE(o.stripe_status, '') <> 'restricted')
      )
  `, runMigrations)) as {
    restaurant_reference: string; name: string; slug: string | null; cuisine: string | null
    description: string | null; image_url: string | null; lat: string | null; lng: string | null
    location: string | null; address: string | null; is_disco_native: boolean | null
    address_line1: string | null; address_line2: string | null
    city: string | null; state: string | null; zipcode: string | null
    is_premium: boolean | null; order_url: string | null; featured_order: number | null
  }[]

  return rows.map((r) => ({
    reference: r.restaurant_reference,
    name: r.name,
    slug: r.slug,
    cuisine: r.cuisine,
    description: r.description,
    imageUrl: r.image_url,
    lat: r.lat,
    lng: r.lng,
    location: r.location,
    // THROUGH THE SHARED FORMATTER, not the raw column. The stored value is
    // correct again after the backfill, but composing it here from the parts
    // means a row that has not re-synced yet still renders once rather than
    // twice. Falls back to the stored string for the 23 rows whose
    // address_line1 does not carry the street (see dedupeAddressString).
    address: formatDisplayAddress({
      addressLine1: r.address_line1, addressLine2: r.address_line2,
      city: r.city, state: r.state, zipcode: r.zipcode,
    }) || dedupeAddressString(r.address) || r.address,
    isDiscoNative: r.is_disco_native,
    isPremium: r.is_premium,
    orderUrl: r.order_url,
    featuredOrder: r.featured_order,
  }))
}
