// M3 conversion tooling — pre-flight checklist. Surfaces every known conversion
// blocker for a restaurant UP FRONT, in one pass, instead of discovering them one
// at a time mid-conversion (the exact shape of friction hit converting Francesca
// Catering's two locations: the menu gap wasn't found until after Stripe was
// linked; the duplicate FM record wasn't found until manually cross-checking
// addresses; login status was never checked at all). Read-only — never mutates,
// never calls convertToNative/importRestaurantStripeAccount itself.
import type Stripe from 'stripe'
import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { verifyAccountReusable, type AccountReuseCheck } from './stripe-connect'
import { resolveStripeAccountFromHistory } from './stripe-account-resolution'
import { checkMultiUnit, type MultiUnitPreflight } from './locations/multi-unit-preflight'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const arrOf = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[]
  const o = d as { content?: unknown; data?: unknown } | null
  return (Array.isArray(o?.content) ? o!.content : Array.isArray(o?.data) ? o!.data : []) as Record<string, unknown>[]
}
async function fmGet(path: string, auth: Record<string, string>): Promise<unknown> {
  const r = await fetch(`${FM}${path}`, { headers: { ...auth, Accept: 'application/json' } })
  if (!r.ok) return null
  return r.json().catch(() => null)
}
// Same sentinel shape importRestaurantStripeAccount uses for a login-disabled
// holder row created before any real admin has ever logged in.
const SENTINEL_EMAIL_RE = /^stripe-import\+.+@familymeal\.com$/i

export interface PreflightBlocker { code: string; message: string }

export interface PreflightResult {
  restaurantReference: string
  name: string | null
  found: boolean
  ready: boolean
  blockers: PreflightBlocker[]
  warnings: PreflightBlocker[]
  menu: { fmTotalItems: number; neonTotalItems: number; gap: number; matches: boolean }
  stripe: {
    resolvedAccountId: string | null
    resolutionSource: 'payment_intent' | 'charge' | 'already-linked' | null
    needsManualLookup: boolean
    detail: string
    capability: AccountReuseCheck | null
  }
  duplicateRecords: { restaurantReference: string; name: string | null }[]
  login: { hasAccount: boolean; isSentinel: boolean; email: string | null }
  fmOnlineOrderingAllowed: boolean | null
  /**
   * The chain's /locations link. PETER-classified when this restaurant is part of a chain and
   * no native link covers it — seeding one is manual until the conversion step is built, and
   * the FM fallback hides its absence completely (Gracious went three weeks unnoticed).
   */
  multiUnit: MultiUnitPreflight
}

async function storedAccountId(ref: string): Promise<string | null> {
  const rows = (await sql`
    SELECT stripe_account_id FROM disco_restaurant_accounts
    WHERE (restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}) AND stripe_account_id IS NOT NULL
    ORDER BY stripe_onboarding_complete DESC NULLS LAST, id ASC LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string | null }[]
  return rows[0]?.stripe_account_id ?? null
}

export async function runPreflightCheck(ref: string, opts?: { stripe?: Stripe }): Promise<PreflightResult> {
  const blockers: PreflightBlocker[] = []
  const warnings: PreflightBlocker[] = []

  const cache = (await sql`
    SELECT name, address, is_disco_native FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { name: string | null; address: string | null; is_disco_native: boolean | null }[]
  const found = cache.length > 0
  const name = cache[0]?.name ?? null

  if (!found) {
    return {
      restaurantReference: ref, name: null, found: false, ready: false,
      blockers: [{ code: 'not-found', message: 'Restaurant not found in disco_restaurant_cache.' }],
      warnings: [],
      menu: { fmTotalItems: 0, neonTotalItems: 0, gap: 0, matches: false },
      stripe: { resolvedAccountId: null, resolutionSource: null, needsManualLookup: true, detail: 'Restaurant not found.', capability: null },
      duplicateRecords: [], login: { hasAccount: false, isSentinel: false, email: null },
      fmOnlineOrderingAllowed: null,
      // A restaurant that is not in the cache has no chain to check.
      multiUnit: {
        isChain: false, grantedRefs: [], grantsBySystemAdmin: [], nativeLink: null,
        fm: null, divergence: null, detail: 'Restaurant not found — no multi-unit check run.',
      },
    }
  }

  let auth: Record<string, string> | null = null
  try { auth = await getFmServiceAuthHeader() } catch { /* FM checks below degrade gracefully */ }

  // ── 1. Menu completeness — FM's real total (all menus, any status) vs Neon's ──
  // A coarse total-count comparison, not a full item-by-item diff (too expensive
  // to run per-restaurant in a batch tool) — but it's exactly the signal that
  // caught the real Francesca Catering bug (64 in Neon vs 172 on FM), and
  // Neon < FM can NEVER be explained by legitimate cross-menu duplication (only
  // Neon >= FM can), so it's a correct, cheap necessary check.
  let fmTotalItems = 0
  if (auth) {
    const flat = arrOf(await fmGet(`/api/restaurants/${ref}/mealPackages?page=0&size=1000`, auth))
    fmTotalItems = flat.length
  }
  const neonItems = (await sql`SELECT COUNT(*)::int AS n FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid`.catch(() => [{ n: 0 }])) as { n: number }[]
  const neonTotalItems = neonItems[0]?.n ?? 0
  // fmTotalItems === 0 is vacuously "complete" — nothing on FM to be missing (a
  // genuinely FM-less native signup, or FM auth/lookup failed; either way there's
  // no FM baseline to compare against, so this is NOT the same thing as a real gap).
  const menuMatches = fmTotalItems === 0 || neonTotalItems >= fmTotalItems
  if (fmTotalItems > 0 && neonTotalItems === 0) {
    blockers.push({ code: 'menu-not-imported', message: 'No native menu imported yet — run the faithful FM import first.' })
  } else if (fmTotalItems > 0 && neonTotalItems < fmTotalItems) {
    blockers.push({ code: 'menu-incomplete', message: `Neon has ${neonTotalItems} items but FM has ${fmTotalItems} real items across all menus — likely missing Inactive/Archived-menu content (same bug class fixed for Francesca Catering).` })
  }

  // ── 2. Stripe account resolution ──────────────────────────────────────────────
  const existingAccountId = await storedAccountId(ref)
  let stripeResult: PreflightResult['stripe']
  if (existingAccountId) {
    const cap = await verifyAccountReusable(existingAccountId, opts?.stripe)
    stripeResult = { resolvedAccountId: existingAccountId, resolutionSource: 'already-linked', needsManualLookup: false, detail: `Already linked (${existingAccountId}).`, capability: cap }
    if (!cap.reusable) blockers.push({ code: 'stripe-not-reusable', message: `Linked account ${existingAccountId} is not charge-capable: ${cap.reason}` })
  } else {
    const resolution = await resolveStripeAccountFromHistory(ref, opts?.stripe)
    if (resolution.accountId) {
      const cap = await verifyAccountReusable(resolution.accountId, opts?.stripe)
      stripeResult = { resolvedAccountId: resolution.accountId, resolutionSource: resolution.source, needsManualLookup: false, detail: resolution.detail, capability: cap }
      if (!cap.reusable) blockers.push({ code: 'stripe-not-reusable', message: `Auto-resolved account ${resolution.accountId} is not charge-capable: ${cap.reason}` })
    } else {
      stripeResult = { resolvedAccountId: null, resolutionSource: null, needsManualLookup: true, detail: resolution.detail, capability: null }
      blockers.push({ code: 'stripe-needs-manual-lookup', message: `No Stripe account resolvable from payment history — ${resolution.detail}` })
    }
  }

  // ── 3. Duplicate/messy FM records (same address) ────────────────────────────
  const normalizedAddr = (cache[0]?.address || '').trim().toLowerCase()
  let duplicateRecords: PreflightResult['duplicateRecords'] = []
  if (normalizedAddr) {
    const dupes = (await sql`
      SELECT restaurant_reference, name FROM disco_restaurant_cache
      WHERE restaurant_reference != ${ref} AND LOWER(TRIM(address)) = ${normalizedAddr}
    `.catch(() => [])) as { restaurant_reference: string; name: string | null }[]
    duplicateRecords = dupes.map(d => ({ restaurantReference: d.restaurant_reference, name: d.name }))
    if (dupes.length) {
      warnings.push({ code: 'duplicate-address', message: `${dupes.length} other FM record(s) share this exact address — confirm which is the real, active one before converting (do not act on the others). ${dupes.map(d => `${d.name} (${d.restaurant_reference})`).join('; ')}` })
    }
  }

  // ── 4. Login/account status ──────────────────────────────────────────────────
  const acctRows = (await sql`
    SELECT email FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}
    ORDER BY created_at ASC LIMIT 1
  `.catch(() => [])) as { email: string }[]
  const hasAccount = acctRows.length > 0
  const isSentinel = hasAccount && SENTINEL_EMAIL_RE.test(acctRows[0].email)
  if (!hasAccount) {
    warnings.push({ code: 'no-login-yet', message: 'No Disco login exists yet — one will be created (sentinel) on Stripe import, or invited automatically on conversion if a real FM admin email is found.' })
  } else if (isSentinel) {
    warnings.push({ code: 'sentinel-login-only', message: `Only a placeholder login exists (${acctRows[0].email}) — no real admin can log in yet.` })
  }

  // ── 5. Basic readiness: FM's own online-ordering flag ───────────────────────
  let fmOnlineOrderingAllowed: boolean | null = null
  if (auth) {
    const fmRestaurant = await fmGet(`/api/admin/restaurants/${ref}`, auth) as { onlineOrderingAllowed?: boolean } | null
    fmOnlineOrderingAllowed = fmRestaurant?.onlineOrderingAllowed ?? null
    if (fmOnlineOrderingAllowed === false) {
      blockers.push({ code: 'fm-online-ordering-off', message: 'FM itself has onlineOrderingAllowed=false for this restaurant — resolve on FM\'s side first.' })
    }
  }

  // Notification recipients — confirmed no automated import path exists at all
  // (session-scoped-only FM endpoint); always a manual post-conversion step, never
  // a blocker.
  const ov = (await sql`SELECT notification_emails, notification_sms_numbers FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`.catch(() => [])) as { notification_emails: string | null; notification_sms_numbers: string | null }[]
  if (!ov[0]?.notification_emails && !ov[0]?.notification_sms_numbers) {
    warnings.push({ code: 'notification-recipients-unset', message: 'Notification email/SMS recipients are not set and cannot be auto-imported (FM exposes this only via a session-scoped endpoint) — Peter needs to enter these manually via the portal.' })
  }

  // ── 6. Multi-unit /locations link ───────────────────────────────────────────
  // PETER, not BLOCKER: converting without a link does not break anything, which is exactly
  // the problem — the FM fallback serves the page and nothing looks wrong. It is a manual step
  // until the conversion step exists, so it belongs in the report someone reads BEFORE
  // converting rather than in a runbook step that gets skipped.
  const multiUnit = await checkMultiUnit(ref, name)
  if (multiUnit.isChain && !multiUnit.nativeLink) {
    warnings.push({
      code: 'multi-unit-link-missing',
      message: `PETER — this is a ${multiUnit.grantedRefs.length}-location chain with NO Disco-native /locations link, so its page will keep being served by FM's group endpoint after conversion. ${multiUnit.detail} Seed it by hand (runbook Tier 1 step 11); membership comes from disco_restaurant_location_access, FM supplies the slug and title only.`,
    })
  } else if (multiUnit.isChain && multiUnit.nativeLink) {
    const covered = new Set(multiUnit.nativeLink.memberRefs)
    const missing = multiUnit.grantedRefs.filter(g => g.isDiscoNative && !covered.has(g.restaurantReference))
    if (missing.length) {
      warnings.push({
        code: 'multi-unit-link-incomplete',
        message: `PETER — native link '${multiUnit.nativeLink.slug}' exists but is missing ${missing.length} converted location(s): ${missing.map(m => m.name || m.restaurantReference).join(', ')}. A chain converts one location at a time, so the link has to GROW — add this member after converting.`,
      })
    }
  }
  if (multiUnit.divergence && (multiUnit.divergence.inFmNotGranted.length || multiUnit.divergence.grantedNotInFm.length)) {
    warnings.push({
      code: 'multi-unit-membership-diverges',
      message: `FM's group '${multiUnit.fm?.slug}' and disco_restaurant_location_access disagree — ${multiUnit.divergence.inFmNotGranted.length} in FM but not granted, ${multiUnit.divergence.grantedNotInFm.length} granted but not in FM. FM's group endpoint over-reports (Morning Squeeze on /locations/eggstasy), so STOP and ask rather than copying either side.`,
    })
  }

  return {
    restaurantReference: ref, name, found: true,
    ready: blockers.length === 0,
    blockers, warnings,
    menu: { fmTotalItems, neonTotalItems, gap: Math.max(0, fmTotalItems - neonTotalItems), matches: menuMatches },
    stripe: stripeResult,
    duplicateRecords,
    login: { hasAccount, isSentinel, email: acctRows[0]?.email ?? null },
    fmOnlineOrderingAllowed,
    multiUnit,
  }
}

export async function runPreflightBatch(refs: string[], opts?: { stripe?: Stripe }): Promise<PreflightResult[]> {
  const results: PreflightResult[] = []
  for (const ref of refs) results.push(await runPreflightCheck(ref, opts))
  return results
}
