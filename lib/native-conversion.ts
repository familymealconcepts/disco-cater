// M3 — FM-backed → Disco-native conversion tooling.
//
// Converting an existing FM restaurant to fully Disco-native is a sequenced,
// verify-before-flip operation. The heavy steps (build the native menu, obtain a
// usable Stripe account) are done with existing tools + the account-id import; this
// module ORCHESTRATES the readiness check and performs the one irreversible-feeling
// step — flipping is_disco_native — only when every prerequisite passes, with
// marketplace visibility preserved (never silently dropped) via the M4 gate.
//
// STRIPE (reuse model): rather than force fresh onboarding, we REUSE the existing
// FM-linked connected account when it is already charge-capable — a LIVE per-account
// capability check (verifyAccountReusable), never a money_flow/proxy. Fresh
// onboarding is the fallback ONLY for accounts that genuinely can't be reused.
import type Stripe from 'stripe'
import { sql, runMigrations } from './db'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { checkMarketplaceReadiness } from './marketplace-readiness'
import { evaluateMarketplaceReadiness } from './marketplace-visibility'
import { readWalledFieldsForRestaurants, type FmWalledFieldsResult } from './fm-master-admin-read'
import { verifyAccountReusable } from './stripe-connect'
import { syncRestaurantOrders } from './fm-orders-sync'
import { setInviteToken, grantLocationAccess } from './disco-restaurant-auth'
import { sendTeamMemberInvite } from './email/notifications'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { sanitizePhone } from './utils/phone'
import { isHolidayName } from './holidays'
import { fmImageUrl } from './fm-image'

const SITE_URL = 'https://www.discocater.com'
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
// Same sentinel shape importRestaurantStripeAccount uses for a login-disabled
// holder row created before any real admin has ever logged in.
const SENTINEL_EMAIL_RE = /^stripe-import\+.+@familymeal\.com$/i

// Does this disco_restaurant_accounts row actually work right now? Two real
// signals, checked directly instead of inferred from the email's shape:
//   (a) a LIVE (unexpired) invite_token — a second invite would needlessly
//       invalidate/duplicate an active one.
//   (b) any disco_restaurant_sessions row ever created for this email —
//       accept-invite's POST always creates one immediately on success
//       (app/api/restaurant/accept-invite/route.ts), so its mere existence
//       proves a real password was set at least once, regardless of what the
//       CURRENT invite_token/password_hash look like.
// Replaces inferring viability from SENTINEL_EMAIL_RE: a row created by
// importRestaurantStripeAccount with a REAL email (exactly what the runbook
// instructs passing) doesn't match that pattern, so it read as "a working
// login already exists" while actually having invite_token NULL and an
// unguessable random password — no invite was ever sent and no one could log
// in. Confirmed live: The Winkin' Rooster hit exactly this.
async function hasUsableLogin(
  email: string,
  inviteToken: string | null,
  inviteTokenExpiresAt: string | Date | null,
): Promise<boolean> {
  const hasLiveInvite = inviteToken != null && inviteTokenExpiresAt != null && new Date(inviteTokenExpiresAt) > new Date()
  if (hasLiveInvite) return true
  const sessions = (await sql`SELECT 1 FROM disco_restaurant_sessions WHERE email = ${email} LIMIT 1`.catch(() => [])) as unknown[]
  return sessions.length > 0
}

// Full FM order-history backfill for a restaurant — pulls ALL of FM's order history
// into disco_orders (source_of_order='FAMILYMEAL') so the native lead-gen fee tier
// carries over on conversion (countPriorPaidOrders counts these). Deep page cap so a
// long-lived restaurant's full history is captured; the sync stops early on the last
// page. Items skipped (order-level only) to keep it fast. Gated into convertToNative.
export async function backfillFmOrderHistory(ref: string): Promise<{
  ok: boolean; fetched: number; inserted: number; updated: number; skipped: number; error?: string
}> {
  try {
    const r = await syncRestaurantOrders(ref, { withItems: false, pageSize: 100, maxPages: 500 })
    return { ok: !r.error, fetched: r.fetched, inserted: r.inserted, updated: r.updated, skipped: r.skipped, error: r.error }
  } catch (e) {
    return { ok: false, fetched: 0, inserted: 0, updated: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export type StripeMode = 'reuse' | 'needs-onboarding' | 'not-linked'

export interface ConversionStep {
  key: 'not-already-native' | 'native-menu' | 'stripe-ready' | 'settings' | 'marketplace-ready'
  label: string
  done: boolean
  blocking: boolean
  detail: string
}

export interface ConversionReadiness {
  restaurantReference: string
  found: boolean
  isDiscoNative: boolean
  isLive: boolean
  stripeMode: StripeMode
  steps: ConversionStep[]
  ordersMirrored: number       // advisory: run a final sync/fm-orders before flipping
  ready: boolean               // all BLOCKING steps pass
  // Set ONLY when the settings gate had to fall through to a live
  // master-password read (Neon had no real tax rate). convertToNative reuses
  // this instead of fetching again, so a restaurant with no Neon rate yet
  // still costs exactly one login per conversion attempt, never two.
  fetchedWalled?: FmWalledFieldsResult
}

// The admin restaurant list is a pure FM passthrough (app/api/admin/restaurants),
// so the Edit Restaurant dialog always opens with the restaurant's FM reference —
// never its native one. Resolve that to the canonical native restaurant_reference
// via disco_restaurant_accounts (populated for every native signup, including
// become-a-partner's shadow FM record) BEFORE reading is_disco_native, so a stale
// disco_restaurant_cache row left keyed under the FM reference (e.g. from the daily
// FM-mirror cron re-upserting under r.reference) can never be mistaken for the
// restaurant's real native status. Falls back to the input ref unchanged when no
// account mapping exists — i.e. a restaurant that was never linked to a Disco
// account, where ref already IS the only reference that matters.
async function resolveNativeRef(ref: string): Promise<string> {
  const rows = (await sql`
    SELECT restaurant_reference FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}
  `.catch(() => [])) as { restaurant_reference: string | null }[]
  if (rows.some(r => r.restaurant_reference === ref)) return ref
  return rows[0]?.restaurant_reference || ref
}

// Resolve the connected-account id Disco has stored for this restaurant (native or
// the FM bridge), preferring a completed one.
async function storedAccountId(ref: string): Promise<string | null> {
  const rows = (await sql`
    SELECT stripe_account_id FROM disco_restaurant_accounts
    WHERE (restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}) AND stripe_account_id IS NOT NULL
    ORDER BY stripe_onboarding_complete DESC NULLS LAST, id ASC
    LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string | null }[]
  return rows[0]?.stripe_account_id ?? null
}

export async function checkConversionReadiness(
  ref: string,
  opts?: { stripe?: Stripe; prefetchedWalled?: FmWalledFieldsResult },
): Promise<ConversionReadiness> {
  await runMigrations()

  const nativeRef = await resolveNativeRef(ref)

  const cache = (await sql`
    SELECT name, is_disco_native, is_live FROM disco_restaurant_cache WHERE restaurant_reference = ${nativeRef} LIMIT 1
  `) as { name: string | null; is_disco_native: boolean | null; is_live: boolean | null }[]
  const found = cache.length > 0
  const isDiscoNative = cache[0]?.is_disco_native === true
  const isLive = cache[0]?.is_live === true

  // Native menu: a visible, non-archived disco_menus row (native pricing reads the
  // primary visible menu). restaurant_reference is UUID on disco_menus.
  const menu = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_menus
    WHERE restaurant_reference = ${nativeRef}::uuid AND visible = true AND archived = false
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const hasMenu = (menu[0]?.n ?? 0) > 0

  // Stripe (reuse model): LIVE-verify the stored connected account. Reusable →
  // zero onboarding. Not charge-capable → onboarding fallback. No account → not linked.
  const acctId = await storedAccountId(nativeRef)
  let stripeMode: StripeMode = 'not-linked'
  let stripeDetail = 'No Stripe account linked — run the account-id import (reuse) or onboard.'
  if (acctId) {
    const check = await verifyAccountReusable(acctId, opts?.stripe)
    stripeMode = check.reusable ? 'reuse' : 'needs-onboarding'
    stripeDetail = check.reusable
      ? `Reusing existing account ${acctId} — charge-capable, no onboarding needed.`
      : `Account ${acctId} can't be reused: ${check.reason}`
  }
  const stripeReady = stripeMode === 'reuse'

  // Settings: an overrides row with a REAL state tax percent (not just a non-null
  // tax_rates shell) and online ordering not off. Previously checked only
  // `!!tax_rates` — every one of DeCheco's 6 locations has a non-null tax_rates
  // JSON with stateSalesTax.percent/localSalesTax.percent both null, and this
  // passed anyway ("Tax rates mirrored") — a false positive that would have let
  // a restaurant go native pricing every order at $0 tax. 0 is a real, valid
  // percent (Pelican Delicatessen is deliberately 0%) — only null/missing fails.
  const ov = (await sql`
    SELECT tax_rates, online_ordering_enabled FROM disco_restaurant_overrides
    WHERE restaurant_reference = ${nativeRef} LIMIT 1
  `.catch(() => [])) as { tax_rates: { stateSalesTax?: { percent?: number | null } } | null; online_ordering_enabled: boolean | null }[]
  let stateTaxPct = ov[0]?.tax_rates?.stateSalesTax?.percent
  let hasRealStateTaxPct = typeof stateTaxPct === 'number' && Number.isFinite(stateTaxPct)
  let taxSource: 'neon' | 'live-master-password' = 'neon'
  // Populated only if a live read actually happened below — convertToNative
  // picks this up so it never fetches a second time for the same conversion.
  let fetchedWalled: FmWalledFieldsResult | undefined

  // Alpharetta's catch-22, fixed: a brand-new restaurant never has its tax rate
  // mirrored to Neon by anything until this check runs (the old opportunistic
  // mirror only fires when a restaurant's OWN admin views the tax page; the
  // conversion carry-over that would otherwise populate it doesn't run until
  // AFTER this gate passes). Rather than requiring a manual pre-seed, fall
  // through to the SAME master-password read convertToNative uses, but only
  // when Neon genuinely has nothing — a restaurant with an already-real rate
  // never pays this cost. Prefer a caller-supplied prefetchedWalled (see
  // convertToNative, which fetches once and threads it through here AND into
  // the carry-over step, rather than logging in twice for one conversion).
  if (!hasRealStateTaxPct) {
    if (opts?.prefetchedWalled) {
      fetchedWalled = opts.prefetchedWalled
    } else {
      fetchedWalled = (await readWalledFieldsForRestaurants([nativeRef])).get(nativeRef)
    }
    const livePct = fetchedWalled?.ok ? fetchedWalled.taxRate?.stateSalesTax?.percent : undefined
    if (typeof livePct === 'number' && Number.isFinite(livePct)) {
      stateTaxPct = livePct
      hasRealStateTaxPct = true
      taxSource = 'live-master-password'
    }
  }
  const settingsOk = hasRealStateTaxPct && ov[0]?.online_ordering_enabled !== false

  // Orders already mirrored (advisory — a final sync is recommended before flip).
  const orders = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_orders WHERE restaurant_reference = ${nativeRef}::uuid
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const ordersMirrored = orders[0]?.n ?? 0

  // M4 gate: would it stay visible under the native 3-part rule?
  const mk = await checkMarketplaceReadiness(nativeRef)
  const marketplaceReady = mk.wouldBeVisibleAsNative === true

  const steps: ConversionStep[] = [
    { key: 'not-already-native', label: 'Not already Disco-native', done: found && !isDiscoNative, blocking: true, detail: !found ? 'Restaurant not found.' : isDiscoNative ? 'Already Disco-native.' : 'FM-backed — eligible to convert.' },
    { key: 'native-menu', label: 'Native menu built', done: hasMenu, blocking: true, detail: hasMenu ? 'A visible Disco-native menu exists.' : 'No visible native menu — run the menu import (dual-write) first.' },
    // Advisory, not blocking (bulk-migration reframe): most FM restaurants have no
    // Stripe account, will never be marketplace-visible, and will never take an
    // order — conversion is a data migration, not a go-live, so it must not wait
    // on payment capability. Still reported so an operator can see it at a glance.
    { key: 'stripe-ready', label: 'Stripe account usable', done: stripeReady, blocking: false, detail: stripeDetail },
    // Blocking: a native restaurant with no real state tax percent charges wrong
    // money — $0 tax — on every single order. Left blocking deliberately (unlike
    // stripe-ready/marketplace-ready above) — checkout's own taxReliable refusal
    // (lib/pricing/native-order.ts) is the real guard against a bad CHARGE, but
    // this gate is what stops a restaurant from converting into a state where a
    // future order attempt just bounces with a 409 instead of ever being priced.
    { key: 'settings', label: 'Settings populated', done: settingsOk, blocking: true, detail: settingsOk ? `State tax percent set (${taxSource === 'live-master-password' ? 'read live via master-password session' : 'Neon'}); online ordering on.` : !hasRealStateTaxPct ? 'No real state tax percent set — Neon has none, and a live master-password read found none either (no real admin identity, login failed, or FM itself has no rate on file) — populate the actual rate before converting.' : 'Enable online ordering.' },
    // Advisory, not blocking — same bulk-migration reframe as stripe-ready: a
    // restaurant that would drop off the marketplace under the native 3-part rule
    // (usually because it has no Stripe) should still convert with its data intact;
    // it just won't be visible or orderable until Stripe is connected. convertToNative
    // computes visible/is_live from this same rule rather than forcing true, so a
    // restaurant that fails this check converts correctly hidden, not incorrectly live.
    { key: 'marketplace-ready', label: 'Won’t drop off marketplace', done: marketplaceReady, blocking: false, detail: marketplaceReady ? 'Passes the native 3-part visibility rule.' : `Would be hidden as native: ${mk.blockers.map(b => b.message).join(' ') || 'check visibility.'}` },
  ]

  const ready = found && steps.filter(s => s.blocking).every(s => s.done)
  return { restaurantReference: nativeRef, found, isDiscoNative, isLive, stripeMode, steps, ordersMirrored, ready, fetchedWalled }
}

export interface ConversionResult {
  converted: boolean
  reason?: string
  readiness: ConversionReadiness
  invite?: InviteResult
  systemAdminInvites?: SystemAdminInviteResult[]
  notificationSettings?: NotificationCarryOverResult
  closedDays?: ClosedDaysCarryOverResult
  promoCodes?: PromoCodesCarryOverResult
  profileFields?: ProfileFieldsCarryOverResult
  taxRates?: TaxRatesCarryOverResult
  // Structural, not optional-to-skip: the runbook's Tier-1 checklist calls for
  // a before/after order-count-and-revenue comparison, and it was missed on
  // the first real batch (Atlanta Bread) because nothing forced it to be
  // captured. Recorded by the conversion itself now, so whoever runs it always
  // has both numbers in the result rather than needing to remember to check.
  orderStats?: { before: OrderStatsSnapshot; after: OrderStatsSnapshot }
}

export interface OrderStatsSnapshot {
  count: number
  revenue: number
}

async function snapshotOrderStats(ref: string): Promise<OrderStatsSnapshot> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS revenue
    FROM disco_orders WHERE restaurant_reference = ${ref}::uuid
  `.catch(() => [{ n: 0, revenue: 0 }])) as { n: number; revenue: number }[]
  return { count: rows[0]?.n ?? 0, revenue: rows[0]?.revenue ?? 0 }
}

export interface TaxRatesCarryOverResult {
  carried: boolean
  reason: string
}

export interface InviteResult {
  invited: boolean
  email: string | null
  reason: string
}

// ── Auto-invite on conversion ─────────────────────────────────────────────────
// A freshly-converted restaurant frequently has NO working Disco login yet — either
// none at all, or only the login-disabled sentinel row importRestaurantStripeAccount
// creates (email stripe-import+{ref}@familymeal.com, an unguessable random
// password) when no account existed to attach the Stripe id to. Without this, a
// restaurant can be fully converted and still have no real person able to log in
// to manage it. Fetches the restaurant's REAL admin identity from FM (never reuses
// the sentinel's fake email) and sends the same "set your password" invite already
// used for sub-admins. Best-effort — never blocks or fails the conversion itself.
export async function ensureRestaurantLoginInvited(ref: string, restaurantName: string | null): Promise<InviteResult> {
  const existing = (await sql`
    SELECT email, invite_token, invite_token_expires_at FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}
    ORDER BY created_at ASC LIMIT 1
  `.catch(() => [])) as { email: string; invite_token: string | null; invite_token_expires_at: string | null }[]

  if (existing.length) {
    const row = existing[0]
    if (await hasUsableLogin(row.email, row.invite_token, row.invite_token_expires_at)) {
      return { invited: false, email: row.email, reason: 'Working login already exists (live invite or prior sign-in) — skipped.' }
    }
    // Genuinely stuck: no live invite, never logged in. If the email is
    // already real (not the auto-generated placeholder), just (re)invite it
    // directly — this is exactly the importRestaurantStripeAccount gap: a
    // real email got attached to the row but no invite was ever issued for
    // it. Don't route this through the FM-lookup/upgrade path below, which
    // would re-fetch and overwrite an email that's already correct.
    if (!SENTINEL_EMAIL_RE.test(row.email)) {
      const token = await setInviteToken(row.email)
      const sent = await sendTeamMemberInvite({
        to: row.email,
        inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
        restaurantName: restaurantName || undefined,
      })
      return {
        invited: sent.success, email: row.email,
        reason: sent.success ? 'Invited — a real email was attached to this account but never invited.' : 'Invite email failed to send (account already existed).',
      }
    }
    // else: still the raw sentinel placeholder email — fall through to the
    // FM lookup + upgrade-in-place path below, unchanged.
  }

  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) {
    return { invited: false, email: null, reason: `FM auth failed, could not look up real admin email: ${e instanceof Error ? e.message : e}` }
  }
  const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...auth, Accept: 'application/json' } })
  if (!res.ok) return { invited: false, email: null, reason: `FM restaurant lookup failed (${res.status}).` }
  const fmRestaurant = await res.json().catch(() => null) as {
    admin?: { email?: string; firstName?: string; lastName?: string; enabled?: boolean }
  } | null
  const admin = fmRestaurant?.admin
  const email = (admin?.email || '').trim().toLowerCase()
  if (!email || admin?.enabled === false) {
    return { invited: false, email: null, reason: 'No real, enabled FM admin email found — cannot auto-invite.' }
  }

  try {
    if (existing.length) {
      // Upgrade the sentinel row in place — same restaurant_reference, real identity.
      await sql`
        UPDATE disco_restaurant_accounts
        SET email = ${email}, first_name = ${admin?.firstName || null}, last_name = ${admin?.lastName || null}, updated_at = NOW()
        WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}
      `
    } else {
      const sentinelHash = bcrypt.hashSync(randomUUID(), 10) // overwritten when the invite is accepted
      await sql`
        INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, fm_restaurant_reference, first_name, last_name, restaurant_name, role)
        VALUES (${email}, ${sentinelHash}, ${ref}, ${ref}, ${admin?.firstName || null}, ${admin?.lastName || null}, ${restaurantName}, 'ADMIN')
      `
    }
  } catch (e) {
    // Most likely: this email already has an account elsewhere (e.g. the same
    // owner manages another location) — a unique-constraint hit, not a real
    // failure. Don't auto-invite into a collision; flag for manual review instead.
    return { invited: false, email, reason: `Could not attach ${email} to this restaurant (likely already in use elsewhere): ${e instanceof Error ? e.message : e}` }
  }

  const token = await setInviteToken(email)
  const sent = await sendTeamMemberInvite({
    to: email,
    firstName: admin?.firstName,
    inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
    restaurantName: restaurantName || undefined,
  })
  return { invited: sent.success, email, reason: sent.success ? 'Invited — no prior working login existed.' : 'Invite email failed to send (login was still created/upgraded).' }
}

export interface SystemAdminInviteResult {
  email: string
  invited: boolean       // a NEW account+invite was created this call (false if one already existed)
  grantedRefs: string[]  // restaurant_reference values granted/synced this call (idempotent)
  reason: string
}

// FM's SYSTEM_ADMIN structure is a SEPARATE list from the single per-restaurant
// admin field ensureRestaurantLoginInvited reads — a multi-location brand can
// have several SYSTEM_ADMINs covering the same restaurant with none of them
// being that restaurant's own admin field (confirmed real at DeCheco's: Tyron
// User is SYSTEM_ADMIN across all 6 locations but was never any single
// location's per-restaurant admin, so the old conversion path silently never
// invited him). Invite every FM SYSTEM_ADMIN whose managedRestaurants include
// this restaurant, and mirror FM's FULL managedRestaurants set into
// disco_restaurant_location_access for each — not just this one restaurant, so
// a converting brand's grants match FM immediately rather than location-by-
// location as each one happens to convert. Idempotent (ON CONFLICT DO NOTHING)
// and safe to re-run on every conversion in a multi-location batch.
//
// Best-effort, per person: one system admin's failure (FM lookup miss, email
// collision, etc.) must never affect another's, or the conversion itself —
// same non-blocking contract as ensureRestaurantLoginInvited and the
// notification/closed-days/promo-code carry-over steps.
export async function inviteFmSystemAdminsFor(ref: string, restaurantName: string | null): Promise<SystemAdminInviteResult[]> {
  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) {
    return [{ email: '', invited: false, grantedRefs: [], reason: `FM auth failed: ${e instanceof Error ? e.message : e}` }]
  }

  type FmSystemAdmin = {
    firstName?: string; lastName?: string; email?: string; enabled?: boolean
    managedRestaurants?: { reference?: string }[]
  }
  let admins: FmSystemAdmin[]
  try {
    // FM's system-admin list has no working server-side filter (confirmed
    // empirically — see app/api/admin/system-admins/route.ts) but returns its
    // full ~363-record list in one page at this size, so fetch once and match
    // managedRestaurants client-side.
    const res = await fetch(`${FM}/api/admin/users/system-admin?size=2000`, { headers: { ...auth, Accept: 'application/json' } })
    if (!res.ok) return [{ email: '', invited: false, grantedRefs: [], reason: `FM system-admin list failed (${res.status}).` }]
    const j = await res.json().catch(() => null) as { content?: FmSystemAdmin[] } | null
    admins = j?.content || []
  } catch (e) {
    return [{ email: '', invited: false, grantedRefs: [], reason: `FM system-admin list threw: ${e instanceof Error ? e.message : e}` }]
  }

  const covering = admins.filter(a =>
    a.enabled !== false && (a.managedRestaurants || []).some(r => r.reference === ref),
  )

  const results: SystemAdminInviteResult[] = []
  for (const a of covering) {
    const email = (a.email || '').trim().toLowerCase()
    if (!email) continue
    try {
      const existing = (await sql`
        SELECT email, invite_token, invite_token_expires_at FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
      `) as { email: string; invite_token: string | null; invite_token_expires_at: string | null }[]
      let invited = false
      let reason: string

      if (existing.length && await hasUsableLogin(existing[0].email, existing[0].invite_token, existing[0].invite_token_expires_at)) {
        // Real, working login — most commonly because ensureRestaurantLoginInvited
        // (or this same function, on a sibling location's conversion) already
        // created and invited it. Never re-invite; just keep their grants in sync below.
        reason = 'Account already exists with a usable login (live invite or prior sign-in) — location access synced, no new invite sent.'
      } else if (existing.length) {
        // Row exists but is genuinely stuck — no live invite, never logged
        // in (same gap ensureRestaurantLoginInvited had: a row's mere
        // existence used to be treated as "already invited"). Send a fresh
        // invite to the existing email rather than silently treating a
        // dead/never-invited row as done.
        const token = await setInviteToken(email)
        const sent = await sendTeamMemberInvite({
          to: email,
          firstName: a.firstName,
          inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
          restaurantName: restaurantName || undefined,
        })
        invited = sent.success
        reason = sent.success ? 'Existing account had never been invited — invited now.' : 'Existing account found; invite email failed to send.'
      } else {
        const sentinelHash = bcrypt.hashSync(randomUUID(), 10) // overwritten when the invite is accepted
        await sql`
          INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, fm_restaurant_reference, first_name, last_name, restaurant_name, role)
          VALUES (${email}, ${sentinelHash}, ${ref}, ${ref}, ${a.firstName || null}, ${a.lastName || null}, ${restaurantName}, 'SYSTEM_ADMIN')
        `
        const token = await setInviteToken(email)
        const sent = await sendTeamMemberInvite({
          to: email,
          firstName: a.firstName,
          inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
          restaurantName: restaurantName || undefined,
        })
        invited = sent.success
        reason = sent.success ? 'Invited — FM SYSTEM_ADMIN covering this restaurant.' : 'Account created; invite email failed to send.'
      }

      const grantedRefs: string[] = []
      for (const mr of a.managedRestaurants || []) {
        if (!mr.reference) continue
        await grantLocationAccess(email, mr.reference, 'fm-system-admin-sync')
        grantedRefs.push(mr.reference)
      }

      results.push({ email, invited, grantedRefs, reason })
    } catch (e) {
      // Most likely a unique-constraint collision (email in use elsewhere) —
      // flag for manual review rather than letting it affect the next admin.
      results.push({ email, invited: false, grantedRefs: [], reason: `Threw: ${e instanceof Error ? e.message : e}` })
    }
  }
  return results
}

export interface NotificationCarryOverResult {
  carried: boolean
  reason: string
}

// Persisted audit marker — set whenever a conversion's automatic notification
// carry-over fails, so there's a durable record of WHEN/WHY, alongside the console
// log. The admin-visible "needs review" badge does NOT gate on this column though
// (see app/api/admin/restaurant-overrides/route.ts) — it derives straight from
// real state (native + no notification_emails), because this column only starts
// getting set going forward and would otherwise miss every restaurant converted
// before this existed (e.g. Pelican Delicatessen). That derived badge auto-clears
// the moment real notification_emails land, by any means (portal Save, or a direct
// fix like Glen Rock/Elmwood Park's) — no separate "confirmed" checkbox that could
// be clicked without the data actually being real, or forgotten entirely.
async function flagNotificationSettingsNeedReview(ref: string): Promise<void> {
  try {
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, notification_settings_flagged_at, updated_at)
      VALUES (${ref}, NOW(), NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET notification_settings_flagged_at = NOW(), updated_at = NOW()
    `
  } catch (e) {
    // Even the flag write failing must never fail the conversion — but this would
    // be a genuinely new, worse failure mode (silent AND unflagged), so it gets its
    // own loud log distinct from the carry-over failure that triggered it.
    console.error(`[convertToNative] FAILED to persist the notification-settings-needs-review flag for ${ref} (conversion still succeeds, but this gap is now invisible):`, e instanceof Error ? e.message : e)
  }
}

// ── Notification-settings carry-over on conversion ────────────────────────────
// Root cause of the Glen Rock gap: FM's real notification_emails /
// notification_sms_numbers / phoneNotificationType live behind GET
// /api/notifications, session-scoped to a real restaurant admin login — the
// SUPER_ADMIN service account is confirmed permanently denied here regardless
// of any restaurantReference param, no admin-scoped equivalent exists. The FIX
// (this session): a master-password login AS the restaurant's own real ADMIN or
// SYSTEM_ADMIN reads this for real — see lib/fm-master-admin-read.ts, which
// resolves that identity and handles the session/switch/restore safely.
// `walled` is that read, already fetched once per conversion (never re-fetched
// per field — see convertToNative). Falls back to the old service-account
// attempt only when no real admin identity could be resolved at all (in which
// case it's expected to fail exactly as before, and stays flagged for review).
export async function carryOverNotificationSettings(ref: string, walled?: FmWalledFieldsResult): Promise<NotificationCarryOverResult> {
  const fail = async (reason: string): Promise<NotificationCarryOverResult> => {
    console.error(`[convertToNative] notification carry-over FAILED for ${ref}: ${reason}`)
    await flagNotificationSettingsNeedReview(ref)
    return { carried: false, reason }
  }
  const succeed = async (data: { email?: string[]; phoneNumber?: string[]; phoneNotificationType?: string }): Promise<NotificationCarryOverResult> => {
    const emails = Array.from(new Set((data.email || []).map((e) => String(e).trim()).filter(Boolean)))
    const phones = Array.from(new Set((data.phoneNumber || []).map((p) => sanitizePhone(String(p))).filter(Boolean)))
    const textNotificationsEnabled = data.phoneNotificationType === 'ALL'
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, notification_emails, notification_sms_numbers, text_notifications_enabled, notification_settings_flagged_at, updated_at)
      VALUES (${ref}, ${emails.join(',') || null}, ${phones.join(',') || null}, ${textNotificationsEnabled}, NULL, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET notification_emails = ${emails.join(',') || null},
            notification_sms_numbers = ${phones.join(',') || null},
            text_notifications_enabled = ${textNotificationsEnabled},
            notification_settings_flagged_at = NULL,
            updated_at = NOW()
    `
    return { carried: true, reason: `Carried over ${emails.length} email(s), ${phones.length} phone(s) via master-password admin session.` }
  }

  // Master-password path — trust a real 200 at face value (empty is genuinely
  // empty now that the wall no longer applies; it's the OLD service-account
  // path below where an empty result specifically meant "still walled").
  if (walled?.ok && walled.notifications) return succeed(walled.notifications)
  if (walled && !walled.ok) {
    // Fell through master-password resolution (no real admin identity, or the
    // FM login itself failed) — try the old service-account path anyway, in
    // case FM ever opens this up, then flag if that also fails.
  }

  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) {
    return fail(`FM auth failed — could not even attempt the notification-settings fetch: ${e instanceof Error ? e.message : e}`)
  }

  let res: Response
  try {
    res = await fetch(`${FM}/api/notifications?restaurantReference=${ref}`, { headers: { ...auth, Accept: 'application/json' } })
  } catch (e) {
    return fail(`FM notification-settings request threw: ${e instanceof Error ? e.message : e}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return fail(`FM /api/notifications unreachable via service account (HTTP ${res.status}): ${body.slice(0, 200)} — this is the known session-scoped access-control wall${walled ? `; no real per-restaurant admin identity was found either (${walled.reason})` : ''}; real recipients must be entered manually post-conversion.`)
  }

  let data: { email?: string[]; phoneNumber?: string[]; phoneNotificationType?: string } | null = null
  try { data = await res.json() } catch { /* fall through to the reason below */ }
  if (!data) {
    return fail('FM /api/notifications returned a non-JSON or empty body — cannot carry over.')
  }
  return succeed(data)
}

export interface ClosedDaysCarryOverResult {
  carried: boolean
  reason: string
}

// Same audit-marker role as flagNotificationSettingsNeedReview, for the
// closed-days/holiday carry-over. See that function's comment for why this
// column is set unconditionally on failure rather than gating any UI badge —
// the same reasoning applies here.
async function flagClosedDaysNeedReview(ref: string): Promise<void> {
  try {
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, closed_days_flagged_at, updated_at)
      VALUES (${ref}, NOW(), NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET closed_days_flagged_at = NOW(), updated_at = NOW()
    `
  } catch (e) {
    console.error(`[convertToNative] FAILED to persist the closed-days-needs-review flag for ${ref} (conversion still succeeds, but this gap is now invisible):`, e instanceof Error ? e.message : e)
  }
}

// FM's real closed-days entries name a handful of holidays slightly differently
// than Disco's own canonical list (lib/holidays.ts) — confirmed by reading real
// FM data (Pelican Delicatessen, via master-password read) this session.
const FM_HOLIDAY_NAME_ALIASES: Record<string, string> = {
  "President's Day": "Presidents' Day",
  'Easter Day': 'Easter',
}

// FM sends "DD.MM.YYYY"; Postgres date columns need "YYYY-MM-DD".
function fmDateToIso(d: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.trim())
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

// ── Closed-days / holiday carry-over on conversion ────────────────────────────
// FM's real closed-days config lives behind GET /api/closedDays, session-scoped
// to a real restaurant admin login. FIXED (this session): a master-password
// login as the restaurant's own ADMIN/SYSTEM_ADMIN reads this for real — see
// lib/fm-master-admin-read.ts. `walled` is that already-fetched read (see
// convertToNative). Falls back to the old service-account attempt only when no
// real admin identity could be resolved — that path is confirmed permanently
// walled (a 200 with an empty array regardless of the restaurant's real
// config), so an empty result THERE still means "wall," not "no closures." Via
// the master-password path, trust a real empty array at face value — the wall
// no longer applies once the read comes from a genuine admin session.
//
// Real FM shape (confirmed via a live master-password read this session, not
// the earlier guess): `{eventName, available, eventDates: ["DD.MM.YYYY", ...],
// reference}` — NOT the previously-assumed holiday/name/fromDate/toDate shape,
// which real data has now confirmed was wrong.
//
// FM: available: true = ordering unavailable = closed; checked in FM's
// Scheduling Override UI. available: false = unchecked = open. Confirmed
// against Pelican Delicatessen's own real, known state (Peter): exactly one
// box checked there (Memorial Day) — Memorial Day is the only entry with
// available: true, all eleven others available: false. The field name reads
// backwards from its literal sense (`available` is TRUE when the restaurant is
// NOT available to order) — do not re-derive this from the name alone.
export async function carryOverClosedDays(ref: string, walled?: FmWalledFieldsResult): Promise<ClosedDaysCarryOverResult> {
  const fail = async (reason: string): Promise<ClosedDaysCarryOverResult> => {
    console.error(`[convertToNative] closed-days carry-over FAILED for ${ref}: ${reason}`)
    await flagClosedDaysNeedReview(ref)
    return { carried: false, reason }
  }

  type FmClosedDay = { eventName?: string; available?: boolean; eventDates?: string[]; reference?: string }

  const parseAndWrite = async (rows: FmClosedDay[]): Promise<ClosedDaysCarryOverResult> => {
    const inserts: { name: string; holiday: string | null }[] = []
    let skipped = 0
    const dated: { name: string; holiday: string | null; from: string; to: string }[] = []

    for (const row of rows) {
      if (row.available !== true) continue // available: true = closed (see comment above); false = open, nothing to carry over
      const rawName = (row.eventName || '').trim()
      if (!rawName) { skipped++; continue }
      const canonicalName = FM_HOLIDAY_NAME_ALIASES[rawName] || rawName
      const holiday = isHolidayName(canonicalName) ? canonicalName : null
      const dates = (row.eventDates || []).map(fmDateToIso).filter((d): d is string => !!d)
      if (dates.length === 0) { skipped++; continue }
      for (const d of dates) dated.push({ name: canonicalName, holiday, from: d, to: d })
      inserts.push({ name: canonicalName, holiday })
    }

    if (dated.length === 0) {
      return fail(`FM /api/closedDays returned ${rows.length} row(s) but none were usable/closed (unrecognized shape, or the restaurant is open on every listed date) — cannot carry over.`)
    }

    // Replace wholesale rather than merge — this only ever runs once, at
    // conversion, against a restaurant that (per the gate above) has zero rows.
    await sql`DELETE FROM disco_restaurant_closed_days WHERE restaurant_reference = ${ref}::uuid`
    const stmts = dated.map(i => sql`
      INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, holiday, from_date, to_date)
      VALUES (${ref}::uuid, ${i.name}, ${i.holiday}, ${i.from}::date, ${i.to}::date)
    `)
    await sql.transaction(stmts)
    await sql`
      UPDATE disco_restaurant_overrides SET closed_days_flagged_at = NULL, updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `
    const holidayNames = new Set(inserts.filter(i => i.holiday).map(i => i.holiday as string))
    const customCount = inserts.length - holidayNames.size
    return {
      carried: true,
      reason: `Carried over ${holidayNames.size} named holiday(s) [${[...holidayNames].join(', ')}] + ${customCount} custom closed date(s) from ${rows.length} FM row(s) via master-password admin session${skipped ? ` (${skipped} row(s) skipped — unusable)` : ''}.`,
    }
  }

  if (walled?.ok && Array.isArray(walled.closedDays)) {
    if (walled.closedDays.length === 0) {
      // Genuinely trusted now — a real admin session returning zero rows means
      // zero closures, not the wall (the wall only ever applied to the
      // service-account path below).
      await sql`
        UPDATE disco_restaurant_overrides SET closed_days_flagged_at = NULL, updated_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
      return { carried: true, reason: 'FM reports zero closed days for this restaurant (read via master-password admin session — trusted, not the old service-account wall).' }
    }
    return parseAndWrite(walled.closedDays as FmClosedDay[])
  }

  // No real admin identity resolved (or the master-password login itself
  // failed) — fall back to the old, confirmed-walled service-account attempt,
  // in case FM ever opens this up. An empty result here still means the wall.
  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) {
    return fail(`FM auth failed — could not even attempt the closed-days fetch: ${e instanceof Error ? e.message : e}`)
  }

  let res: Response
  try {
    res = await fetch(`${FM}/api/closedDays?restaurantReference=${ref}`, { headers: { ...auth, Accept: 'application/json' } })
  } catch (e) {
    return fail(`FM closed-days request threw: ${e instanceof Error ? e.message : e}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return fail(`FM /api/closedDays unreachable via service account (HTTP ${res.status}): ${body.slice(0, 200)} — this is the known session-scoped access-control wall${walled ? `; no real per-restaurant admin identity was found either (${walled.reason})` : ''}; real closed dates must be entered manually post-conversion.`)
  }

  let data: unknown = null
  try { data = await res.json() } catch { /* fall through to the reason below */ }
  if (!Array.isArray(data)) {
    return fail('FM /api/closedDays returned a non-array body — cannot carry over.')
  }
  if (data.length === 0) {
    return fail('FM /api/closedDays returned an empty array via the service account — the confirmed access-control wall (a restaurant known to have real closures still returns []), not evidence this restaurant has none. Real closed dates must be entered manually.')
  }
  return parseAndWrite(data as FmClosedDay[])
}

// ── Tax-rate carry-over on conversion ─────────────────────────────────────────
// Previously only ever mirrored opportunistically, whenever a restaurant admin
// happened to view FM's tax-rate page while still FM-backed (mirrorTaxRates in
// app/api/restaurant/tax-rate/route.ts) — meaning it was never actually
// attempted AT conversion time, and checkConversionReadiness's blocking
// `settings` gate could fail simply because nobody had opened that page yet,
// not because the rate wasn't real. FIXED (this session): if `walled.taxRate`
// came back from a real master-password admin session, write it here, at
// conversion time, the same way the other two carry-overs do — using the same
// shape mirrorTaxRates already writes (JSON passthrough, no separate flag
// column; the settings gate already reads this value directly).
export async function carryOverTaxRates(ref: string, walled?: FmWalledFieldsResult): Promise<TaxRatesCarryOverResult> {
  if (!walled?.ok || !walled.taxRate) {
    return { carried: false, reason: walled?.reason || 'No master-password read available for tax rates.' }
  }
  const statePct = walled.taxRate.stateSalesTax?.percent
  if (typeof statePct !== 'number' || !Number.isFinite(statePct)) {
    return { carried: false, reason: 'FM returned a tax-rate object but stateSalesTax.percent is null/missing — not a real rate, not carrying over.' }
  }
  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, tax_rates, updated_at)
    VALUES (${ref}, ${JSON.stringify(walled.taxRate)}::jsonb, NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE SET tax_rates = ${JSON.stringify(walled.taxRate)}::jsonb, updated_at = NOW()
  `
  return { carried: true, reason: `Carried over real tax rates (state ${statePct}%) via master-password admin session.` }
}

export interface PromoCodesCarryOverResult {
  carried: boolean
  reason: string
}

// Same audit-marker role as flagClosedDaysNeedReview/flagNotificationSettingsNeedReview.
async function flagPromoCodesNeedReview(ref: string): Promise<void> {
  try {
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, promo_codes_flagged_at, updated_at)
      VALUES (${ref}, NOW(), NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET promo_codes_flagged_at = NOW(), updated_at = NOW()
    `
  } catch (e) {
    console.error(`[convertToNative] FAILED to persist the promo-codes-needs-review flag for ${ref} (conversion still succeeds, but this gap is now invisible):`, e instanceof Error ? e.message : e)
  }
}

// ── Promo-code carry-over on conversion ───────────────────────────────────────
// Same access-control-wall class as notifications and closed-days, confirmed
// via a DIFFERENT signature this time: FM's real promo/coupon config lives
// behind GET /api/coupon (internal name "coupon", not "promoCode" — found by
// probing plausible endpoint names), session-scoped to the restaurant's own
// login. The service account gets a hard HTTP 500 "Access is denied" (FM's
// standard access-control error body), confirmed for Francesca Catering -
// Glen Rock, which we independently know has a real code (FRAN10, 10%, 1000
// uses, 1/diner, 5/17/2023–12/30/2027) that this endpoint cannot see. Unlike
// closedDays/notifications (which "succeed" with an empty array), this fails
// with a real error status, so !res.ok alone reliably catches it — the
// empty-array guard below is kept anyway for defense in depth, in case FM's
// behavior ever changes to match the other two endpoints.
//
// FM's response shape for a NON-EMPTY result is UNVERIFIED — /api/coupon has
// never returned anything but this 500 in every attempt made. Field names are
// guessed from Disco's own promo_codes/restaurant-portal conventions
// (code/discountPercentage/maxAvailable/maxPerDiner/startDate/endDate) with
// a few plausible FM-style alternates; if FM's real shape ever becomes
// reachable and differs, this needs adjusting — the empty-array/unusable-row
// guards mean it fails safe (flagged, not silently wrong) rather than
// inserting garbage.
export async function carryOverPromoCodes(ref: string): Promise<PromoCodesCarryOverResult> {
  const fail = async (reason: string): Promise<PromoCodesCarryOverResult> => {
    console.error(`[convertToNative] promo-code carry-over FAILED for ${ref}: ${reason}`)
    await flagPromoCodesNeedReview(ref)
    return { carried: false, reason }
  }

  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) {
    return fail(`FM auth failed — could not even attempt the promo-code fetch: ${e instanceof Error ? e.message : e}`)
  }

  let res: Response
  try {
    res = await fetch(`${FM}/api/coupon?restaurantReference=${ref}`, { headers: { ...auth, Accept: 'application/json' } })
  } catch (e) {
    return fail(`FM promo-code request threw: ${e instanceof Error ? e.message : e}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return fail(`FM /api/coupon unreachable via service account (HTTP ${res.status}): ${body.slice(0, 200)} — this is the known session-scoped access-control wall; real promo codes must be entered manually post-conversion.`)
  }

  let data: unknown = null
  try { data = await res.json() } catch { /* fall through to the reason below */ }
  if (!Array.isArray(data)) {
    return fail('FM /api/coupon returned a non-array body — cannot carry over.')
  }
  if (data.length === 0) {
    return fail('FM /api/coupon returned an empty array — treated as inconclusive (the same wall confirmed via a 500 elsewhere), not evidence this restaurant has no codes. Real promo codes must be entered manually.')
  }

  type FmCoupon = {
    code?: string | null; couponCode?: string | null
    discountPercentage?: number | string | null; discountValue?: number | string | null; percent?: number | string | null
    maxAvailable?: number | string | null; maxUses?: number | string | null
    maxPerDiner?: number | string | null; maxUsesPerUser?: number | string | null; perDinerLimit?: number | string | null
    startDate?: string | null; validFrom?: string | null; fromDate?: string | null
    endDate?: string | null; validUntil?: string | null; toDate?: string | null
  }
  const rows = data as FmCoupon[]
  const inserts: { code: string; pct: number; maxUses: number | null; maxPerDiner: number; from: string; to: string | null }[] = []
  let skipped = 0

  for (const row of rows) {
    const code = String(row.code ?? row.couponCode ?? '').trim().toUpperCase()
    const pct = Number(row.discountPercentage ?? row.discountValue ?? row.percent)
    const from = row.startDate ?? row.validFrom ?? row.fromDate ?? null
    if (!code || !Number.isFinite(pct) || pct <= 0 || pct > 100 || !from) { skipped++; continue }
    const maxUsesRaw = row.maxAvailable ?? row.maxUses
    const maxUses = maxUsesRaw == null ? null : Number(maxUsesRaw)
    const maxPerDinerRaw = row.maxPerDiner ?? row.maxUsesPerUser ?? row.perDinerLimit
    const maxPerDiner = maxPerDinerRaw == null ? 1 : Number(maxPerDinerRaw)
    const to = row.endDate ?? row.validUntil ?? row.toDate ?? null
    inserts.push({ code, pct, maxUses: Number.isFinite(maxUses as number) ? maxUses : null, maxPerDiner: Number.isFinite(maxPerDiner) ? maxPerDiner : 1, from, to })
  }

  if (inserts.length === 0) {
    return fail(`FM /api/coupon returned ${rows.length} row(s) but none were usable (missing code/discount/date) — cannot carry over.`)
  }

  // Replace wholesale rather than merge — this only ever runs once, at
  // conversion, against a restaurant that (per the gate above) has zero rows.
  await sql`DELETE FROM promo_codes WHERE restaurant_ref = ${ref}`
  const stmts = inserts.map(i => sql`
    INSERT INTO promo_codes (code, discount_type, discount_value, scope, restaurant_ref, funded_by, max_uses, max_uses_per_user, valid_from, valid_until)
    VALUES (${i.code}, 'percent', ${i.pct}, 'restaurant', ${ref}, 'RESTAURANT', ${i.maxUses}, ${i.maxPerDiner}, ${i.from}::timestamptz, ${i.to}::timestamptz)
  `)
  await sql.transaction(stmts)
  return {
    carried: true,
    reason: `Carried over ${inserts.length} promo code(s) [${inserts.map(i => i.code).join(', ')}] from ${rows.length} FM row(s)${skipped ? ` (${skipped} skipped — unusable)` : ''}.`,
  }
}

export interface ProfileFieldsCarryOverResult {
  iconUrlCarried: boolean
  imageUrlCarried: boolean
  phoneCarried: boolean
}

// Logo, marketplace image, and phone — all three sit in the same
// GET /api/admin/restaurants/{ref} response convertToNative already has to
// call (via ensureRestaurantLoginInvited), and none are behind the
// session-scoped wall that blocks notifications/closedDays/coupon — they were
// simply never read here. Fill-blank-only, same pattern (and same fmImageUrl
// helper) as lib/menu-import/fm-faithful-import.ts's identical logic for the
// menu-import step: never overwrites a value that's already set, whatever its
// source (a restaurant can have a real, independently-uploaded image or a
// hand-entered phone with nothing to do with FM). Best-effort — a failure
// here must never affect the conversion itself.
async function carryOverProfileFields(ref: string): Promise<ProfileFieldsCarryOverResult> {
  const empty: ProfileFieldsCarryOverResult = { iconUrlCarried: false, imageUrlCarried: false, phoneCarried: false }
  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch { return empty }

  let fmRestaurant: { image?: unknown; marketplaceImage?: unknown; address?: { phoneNumber?: string } } | null
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...auth, Accept: 'application/json' } })
    if (!res.ok) return empty
    fmRestaurant = await res.json().catch(() => null)
  } catch {
    return empty
  }
  if (!fmRestaurant) return empty

  const fmIconUrl = fmImageUrl(fmRestaurant.image)
  const fmImgUrl = fmImageUrl(fmRestaurant.marketplaceImage)
  const fmPhone = fmRestaurant.address?.phoneNumber?.trim() || null

  const current = (await sql`
    SELECT icon_url, image_url, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref}
  `.catch(() => [])) as { icon_url: string | null; image_url: string | null; phone: string | null }[]
  const row = current[0]

  const setIcon = !!fmIconUrl && !row?.icon_url
  const setImage = !!fmImgUrl && !row?.image_url
  const setPhone = !!fmPhone && !row?.phone
  if (!setIcon && !setImage && !setPhone) return empty

  await sql`
    UPDATE disco_restaurant_cache
    SET icon_url = COALESCE(icon_url, ${fmIconUrl}),
        image_url = COALESCE(image_url, ${fmImgUrl}),
        phone = COALESCE(phone, ${fmPhone}),
        cached_at = NOW()
    WHERE restaurant_reference = ${ref}
  `
  return { iconUrlCarried: setIcon, imageUrlCarried: setImage, phoneCarried: setPhone }
}

// What `is_live` should become on conversion — computed, never forced. Reads
// disco_restaurant_overrides' CURRENT visible/online_ordering_enabled (this runs
// BEFORE is_disco_native flips, so these still reflect FM's own prior state —
// "preserve what FM had," not "force visible") plus a LIVE, capability-verified
// Stripe signal, then runs both through the exact same rule the marketplace feed
// itself uses. A restaurant FM had hidden stays hidden; one FM had live only
// carries over if it would actually survive the stricter native 3-part rule.
//
// Deliberately passes stripeConnected: false — disco_restaurant_overrides
// .stripe_connected is set true historically for ANY restaurant that ever had ANY
// FM-side Stripe account, with no capability check (see marketplace-visibility.ts's
// own "KNOWN GAP" comment), so it can't be trusted as a post-conversion payout
// signal. hasCompletedNativeStripeAccount (a real disco_restaurant_accounts row
// with stripe_onboarding_complete = true) is the only signal that's actually
// meaningful here — which means a restaurant whose Stripe account was only ever
// LIVE-VERIFIED (checkConversionReadiness's stripeMode === 'reuse') but never
// actually IMPORTED (importRestaurantStripeAccount) will compute as not-visible
// here even though it's a perfectly good, reusable account — the import step is
// what persists the row this check reads. Run it before conversion if the
// restaurant should go live immediately.
async function computeNativeIsLive(ref: string): Promise<boolean> {
  const rows = (await sql`
    SELECT o.visible, o.online_ordering_enabled,
           EXISTS (
             SELECT 1 FROM disco_restaurant_accounts a
             WHERE (a.restaurant_reference = ${ref} OR a.fm_restaurant_reference = ${ref})
               AND a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true
           ) AS has_completed_native_stripe
    FROM disco_restaurant_overrides o
    WHERE o.restaurant_reference = ${ref}
    LIMIT 1
  `.catch(() => [])) as { visible: boolean | null; online_ordering_enabled: boolean | null; has_completed_native_stripe: boolean }[]
  const row = rows[0]
  const result = evaluateMarketplaceReadiness({
    isDiscoNative: true,
    visible: row?.visible === true,
    stripeConnected: false,
    onlineOrderingEnabled: row?.online_ordering_enabled ?? null,
    hasCompletedNativeStripeAccount: row?.has_completed_native_stripe === true,
  })
  return result.wouldBeVisibleAsNative
}

// Perform the flip — ONLY when every blocking step passes (today: not-already-
// native, native-menu, settings/tax — stripe-ready and marketplace-ready are
// advisory, per the bulk-migration reframe: most FM restaurants have no Stripe
// account and will never take an order, so conversion must not wait on payment
// capability). `is_live` is computed (computeNativeIsLive above), never forced —
// a restaurant that can't take a real order converts hidden, not incorrectly
// live. Never flips a restaurant that isn't ready.
//
// NOTE: this intentionally does NOT verify goLiveNativeRestaurant's two
// real-action gates (a real live-mode $1 charge actually settling; a real signed
// Expedite dispatch for 3P-delivery restaurants) — those can't be inferred
// passively and require an actual recorded action. Skipping them here is a
// deliberate product decision (this comment exists so it's visible, not silent).
export async function convertToNative(
  ref: string,
  opts?: { stripe?: Stripe; skipInvites?: boolean; prefetchedWalled?: FmWalledFieldsResult },
): Promise<ConversionResult> {
  const readiness = await checkConversionReadiness(ref, opts)
  if (!readiness.found) return { converted: false, reason: 'Restaurant not found.', readiness }
  if (readiness.isDiscoNative) return { converted: false, reason: 'Already Disco-native.', readiness }
  if (!readiness.ready) {
    const failing = readiness.steps.filter(s => s.blocking && !s.done).map(s => s.label).join(', ')
    return { converted: false, reason: `Not ready — resolve: ${failing}.`, readiness }
  }
  // Captured BEFORE the backfill below (which legitimately ADDS rows for any
  // FM history not yet mirrored) — this is the true pre-conversion state, not
  // pre-backfill-and-pre-conversion conflated together.
  const orderStatsBefore = await snapshotOrderStats(readiness.restaurantReference)

  // Gated prerequisite: backfill the restaurant's FULL FM order history into Neon
  // BEFORE flipping, so lead-gen fee tiers carry over for returning customers. If FM
  // is unreachable, do NOT convert — better to retry than flip without history (which
  // would silently reset every returning customer to fee-1).
  const backfill = await backfillFmOrderHistory(ref)
  if (!backfill.ok) {
    return { converted: false, reason: `FM order-history backfill failed (${backfill.error || 'unknown'}) — not converting; retry once FM is reachable.`, readiness }
  }
  // Computed BEFORE the flip so it reads FM's still-current visible/online-ordering
  // state (see computeNativeIsLive's own comment for why this ordering matters).
  const nativeIsLive = await computeNativeIsLive(readiness.restaurantReference)
  await sql`UPDATE disco_restaurant_cache SET is_disco_native = true, is_live = ${nativeIsLive}, cached_at = NOW() WHERE restaurant_reference = ${readiness.restaurantReference}`

  // Best-effort, same contract as everything below — logo/marketplace image/
  // phone are all readable right off the FM restaurant object (unlike
  // notifications/closedDays/promo codes, no session-scoped wall), so this
  // actively carries them over instead of flagging for manual entry.
  let profileFields: ProfileFieldsCarryOverResult
  try {
    profileFields = await carryOverProfileFields(readiness.restaurantReference)
  } catch (e) {
    console.error(`[convertToNative] profile-fields carry-over threw: ${e instanceof Error ? e.message : e}`)
    profileFields = { iconUrlCarried: false, imageUrlCarried: false, phoneCarried: false }
  }

  // Best-effort — a failed invite email or notification-carry-over must never
  // undo or fail an already-successful conversion. Restaurant name for the email
  // body comes from the cache row already confirmed to exist above.
  //
  // skipInvites: for a bulk/batch conversion run where sending real invite
  // emails isn't wanted yet (e.g. a first pass to validate data before any
  // restaurant is contacted) — both invite steps are skipped entirely, not just
  // logged, so NO email is dispatched. Everything else (menu, orders, tax,
  // notifications/closed-days/promo flags, profile fields, is_live) still runs
  // exactly as normal.
  let invite: InviteResult | undefined
  if (opts?.skipInvites) {
    invite = { invited: false, email: null, reason: 'Skipped — batch conversion run with invites suppressed.' }
  } else {
    try {
      const nameRow = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${readiness.restaurantReference} LIMIT 1`) as { name: string | null }[]
      invite = await ensureRestaurantLoginInvited(readiness.restaurantReference, nameRow[0]?.name ?? null)
    } catch (e) {
      invite = { invited: false, email: null, reason: `Invite step threw: ${e instanceof Error ? e.message : e}` }
    }
  }

  // Best-effort, same contract as `invite` above — covers FM SYSTEM_ADMINs that
  // the single per-restaurant admin field never surfaces (see
  // inviteFmSystemAdminsFor's header comment). A failure here must never affect
  // `invite` above, the conversion itself, or any other step below.
  let systemAdminInvites: SystemAdminInviteResult[] = []
  if (!opts?.skipInvites) {
    try {
      const nameRow = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${readiness.restaurantReference} LIMIT 1`) as { name: string | null }[]
      systemAdminInvites = await inviteFmSystemAdminsFor(readiness.restaurantReference, nameRow[0]?.name ?? null)
    } catch (e) {
      console.error(`[convertToNative] system-admin invite step threw: ${e instanceof Error ? e.message : e}`)
    }
  }

  // AT MOST ONE master-password login per conversion, covering all three
  // walled fields at once — never three separate logins for the same
  // restaurant, and never two logins even when the settings gate above had to
  // read live (Neon had no tax rate yet, e.g. a brand-new restaurant like
  // Alpharetta): readiness.fetchedWalled carries that exact read forward, so
  // it's reused here rather than fetched again. A restaurant whose Neon tax
  // rate was already real costs zero logins in the gate and exactly one here,
  // same as before this fix. See lib/fm-master-admin-read.ts for the
  // session/switch/restore handling.
  //
  // opts.prefetchedWalled lets a caller converting several restaurants that
  // share ONE admin (e.g. a batch run) fetch that admin's session ONCE, up
  // front, across all of them — a real multi-restaurant session, one login,
  // one restore — rather than this function re-triggering its own separate
  // login per restaurant.
  let walled: FmWalledFieldsResult | undefined = opts?.prefetchedWalled ?? readiness.fetchedWalled
  if (!walled) {
    try {
      const walledMap = await readWalledFieldsForRestaurants([readiness.restaurantReference])
      walled = walledMap.get(readiness.restaurantReference)
    } catch (e) {
      console.error(`[convertToNative] master-password walled-field read threw for ${readiness.restaurantReference}:`, e instanceof Error ? e.message : e)
    }
  }

  let taxRates: TaxRatesCarryOverResult
  try {
    taxRates = await carryOverTaxRates(readiness.restaurantReference, walled)
  } catch (e) {
    const reason = `Tax-rate carry-over step threw: ${e instanceof Error ? e.message : e}`
    console.error(`[convertToNative] ${reason}`)
    taxRates = { carried: false, reason }
  }
  if (!taxRates.carried) {
    console.error(`[convertToNative] ⚠ ${readiness.restaurantReference} converted WITHOUT real tax rates carried over: ${taxRates.reason}`)
  }

  let notificationSettings: NotificationCarryOverResult
  try {
    notificationSettings = await carryOverNotificationSettings(readiness.restaurantReference, walled)
  } catch (e) {
    const reason = `Notification carry-over step threw: ${e instanceof Error ? e.message : e}`
    console.error(`[convertToNative] ${reason}`)
    notificationSettings = { carried: false, reason }
  }
  if (!notificationSettings.carried) {
    // Loud and explicit — this is exactly the gap that went unnoticed with Glen
    // Rock until it caused a real, undelivered-notification incident.
    console.error(`[convertToNative] ⚠ ${readiness.restaurantReference} converted WITHOUT real notification settings carried over: ${notificationSettings.reason}`)
  }

  let closedDays: ClosedDaysCarryOverResult
  try {
    closedDays = await carryOverClosedDays(readiness.restaurantReference, walled)
  } catch (e) {
    const reason = `Closed-days carry-over step threw: ${e instanceof Error ? e.message : e}`
    console.error(`[convertToNative] ${reason}`)
    closedDays = { carried: false, reason }
  }
  if (!closedDays.carried) {
    // Loud and explicit — same reasoning as the notification-settings gap:
    // a restaurant converting WITHOUT its real closed dates can accept orders
    // for a date it believes it's closed.
    console.error(`[convertToNative] ⚠ ${readiness.restaurantReference} converted WITHOUT real closed-days carried over: ${closedDays.reason}`)
  }

  let promoCodes: PromoCodesCarryOverResult
  try {
    promoCodes = await carryOverPromoCodes(readiness.restaurantReference)
  } catch (e) {
    const reason = `Promo-code carry-over step threw: ${e instanceof Error ? e.message : e}`
    console.error(`[convertToNative] ${reason}`)
    promoCodes = { carried: false, reason }
  }
  if (!promoCodes.carried) {
    // Loud and explicit — same reasoning as notifications/closed-days: a
    // restaurant converting WITHOUT its real promo codes silently breaks any
    // code its customers already know and expect to work.
    console.error(`[convertToNative] ⚠ ${readiness.restaurantReference} converted WITHOUT real promo codes carried over: ${promoCodes.reason}`)
  }

  const orderStatsAfter = await snapshotOrderStats(readiness.restaurantReference)

  return {
    converted: true, readiness: { ...readiness, isDiscoNative: true, isLive: nativeIsLive },
    invite, systemAdminInvites, notificationSettings, closedDays, promoCodes, profileFields, taxRates,
    orderStats: { before: orderStatsBefore, after: orderStatsAfter },
  }
}

// ── Account-id import (M3 bulk-import tool) ──────────────────────────────────
// Store an existing FM connected-account id for a restaurant and LIVE-verify its
// capability. Reusable → mark it usable (stripe_onboarding_complete + overrides
// .stripe_connected) so native checkout, the marketplace feed, and the conversion
// gate all recognize it — zero restaurant effort. Not reusable → still record the
// id (so we know it exists) but leave it flagged for onboarding.
export interface ImportResult {
  restaurantReference: string
  stripeAccountId: string
  reusable: boolean
  mode: 'reuse' | 'needs-onboarding'
  reason: string
}

export async function importRestaurantStripeAccount(
  ref: string,
  accountId: string,
  opts?: { stripe?: Stripe; email?: string; firstName?: string; lastName?: string },
): Promise<ImportResult> {
  await runMigrations()
  const check = await verifyAccountReusable(accountId, opts?.stripe)

  const existing = (await sql`
    SELECT id, first_name, last_name FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref} LIMIT 1
  `.catch(() => [])) as { id: number; first_name: string | null; last_name: string | null }[]

  if (existing.length) {
    // Backfill the name too if the caller supplied one and the row doesn't
    // have one yet (e.g. a placeholder row created before anyone knew who
    // the real admin was) — never overwrites a name that's already set.
    const firstName = opts?.firstName ?? existing[0].first_name
    const lastName = opts?.lastName ?? existing[0].last_name
    await sql`
      UPDATE disco_restaurant_accounts
      SET stripe_account_id = ${accountId}, stripe_onboarding_complete = ${check.reusable},
          first_name = COALESCE(first_name, ${firstName}), last_name = COALESCE(last_name, ${lastName}),
          updated_at = NOW()
      WHERE id = ${existing[0].id}
    `
  } else {
    // No Disco account row yet (pure FM restaurant). Create a login-disabled holder
    // row so native checkout can resolve the connected account. password_hash is a
    // valid bcrypt hash of a random value → login impossible until a real reset.
    // first_name/last_name are caller-supplied only (never fetched from FM here —
    // this bulk tool is called with hundreds of mappings at once; an extra FM
    // round-trip per row belongs to the caller's own choice, not baked in here).
    const sentinel = bcrypt.hashSync(randomUUID(), 10)
    const email = opts?.email || `stripe-import+${ref}@familymeal.com`
    await sql`
      INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, fm_restaurant_reference, stripe_account_id, stripe_onboarding_complete, role, is_disco_native, first_name, last_name)
      VALUES (${email}, ${sentinel}, ${ref}, ${ref}, ${accountId}, ${check.reusable}, 'ADMIN', false, ${opts?.firstName || null}, ${opts?.lastName || null})
    `
  }

  // Reusable → mark connected so the marketplace feed + conversion gate see it.
  if (check.reusable) {
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_connected, updated_at)
      VALUES (${ref}, true, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET stripe_connected = true, updated_at = NOW()
    `
  }

  return { restaurantReference: ref, stripeAccountId: accountId, reusable: check.reusable, mode: check.reusable ? 'reuse' : 'needs-onboarding', reason: check.reason }
}
