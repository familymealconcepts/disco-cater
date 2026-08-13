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
import { verifyAccountReusable } from './stripe-connect'
import { syncRestaurantOrders } from './fm-orders-sync'
import { setInviteToken, grantLocationAccess } from './disco-restaurant-auth'
import { sendTeamMemberInvite } from './email/notifications'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { sanitizePhone } from './utils/phone'
import { holidayDates, isHolidayName } from './holidays'

const SITE_URL = 'https://www.discocater.com'
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
// Same sentinel shape importRestaurantStripeAccount uses for a login-disabled
// holder row created before any real admin has ever logged in.
const SENTINEL_EMAIL_RE = /^stripe-import\+.+@familymeal\.com$/i

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

export async function checkConversionReadiness(ref: string, opts?: { stripe?: Stripe }): Promise<ConversionReadiness> {
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
  const stateTaxPct = ov[0]?.tax_rates?.stateSalesTax?.percent
  const hasRealStateTaxPct = typeof stateTaxPct === 'number' && Number.isFinite(stateTaxPct)
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
    { key: 'stripe-ready', label: 'Stripe account usable', done: stripeReady, blocking: true, detail: stripeDetail },
    // Blocking (was advisory-only): a native restaurant with no real state tax
    // percent charges wrong money — $0 tax — on every single order. That must
    // refuse conversion, not just warn.
    { key: 'settings', label: 'Settings populated', done: settingsOk, blocking: true, detail: settingsOk ? 'State tax percent set; online ordering on.' : !hasRealStateTaxPct ? 'No real state tax percent set (tax_rates may exist but stateSalesTax.percent is null) — populate the actual rate before converting.' : 'Enable online ordering.' },
    { key: 'marketplace-ready', label: 'Won’t drop off marketplace', done: marketplaceReady, blocking: true, detail: marketplaceReady ? 'Passes the native 3-part visibility rule.' : `Would be hidden as native: ${mk.blockers.map(b => b.message).join(' ') || 'check visibility.'}` },
  ]

  const ready = found && steps.filter(s => s.blocking).every(s => s.done)
  return { restaurantReference: nativeRef, found, isDiscoNative, isLive, stripeMode, steps, ordersMirrored, ready }
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
    SELECT email FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}
    ORDER BY created_at ASC LIMIT 1
  `.catch(() => [])) as { email: string }[]

  if (existing.length && !SENTINEL_EMAIL_RE.test(existing[0].email)) {
    return { invited: false, email: existing[0].email, reason: 'Working login already exists — skipped.' }
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
      const existing = (await sql`SELECT email FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1`) as { email: string }[]
      let invited = false
      let reason: string

      if (existing.length) {
        // Already has a login — most commonly because ensureRestaurantLoginInvited
        // (or this same function, on a sibling location's conversion) already
        // created it. Never re-invite; just keep their grants in sync below.
        reason = 'Account already exists — location access synced, no new invite sent.'
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
// Confirmed root cause of the Glen Rock gap: FM's real notification_emails /
// notification_sms_numbers / phoneNotificationType live behind GET /api/notifications,
// which is SESSION-scoped to the restaurant's own login — empirically confirmed
// (2026-08-06) to return 500 "Access is denied" for the service account regardless
// of any restaurantReference param, and no admin-scoped equivalent exists
// (/api/admin/notifications and /api/admin/restaurants/{ref}/notifications both
// 404). This is a real access-control wall, not a transient failure — expect this
// to fail every time until FM exposes an admin-scoped path. Attempted anyway (in
// case that ever changes); every failure both logs loudly AND persists the
// needs-review flag above, so the gap is visible somewhere an admin will actually
// look, not just in the conversion result and function logs.
export async function carryOverNotificationSettings(ref: string): Promise<NotificationCarryOverResult> {
  const fail = async (reason: string): Promise<NotificationCarryOverResult> => {
    console.error(`[convertToNative] notification carry-over FAILED for ${ref}: ${reason}`)
    await flagNotificationSettingsNeedReview(ref)
    return { carried: false, reason }
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
    return fail(`FM /api/notifications unreachable via service account (HTTP ${res.status}): ${body.slice(0, 200)} — this is the known session-scoped access-control wall; real recipients must be entered manually post-conversion.`)
  }

  // Unreachable today (confirmed above), kept for the day FM exposes a real path —
  // same NotificationsShape as app/api/restaurant/notifications' FM-token GET.
  let data: { email?: string[]; phoneNumber?: string[]; phoneNotificationType?: string } | null = null
  try { data = await res.json() } catch { /* fall through to the reason below */ }
  if (!data) {
    return fail('FM /api/notifications returned a non-JSON or empty body — cannot carry over.')
  }

  const emails = Array.from(new Set((data.email || []).map((e) => String(e).trim()).filter(Boolean)))
  const phones = Array.from(new Set((data.phoneNumber || []).map((p) => sanitizePhone(String(p))).filter(Boolean)))
  const textNotificationsEnabled = data.phoneNotificationType === 'ALL'

  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, notification_emails, notification_sms_numbers, text_notifications_enabled, updated_at)
    VALUES (${ref}, ${emails.join(',') || null}, ${phones.join(',') || null}, ${textNotificationsEnabled}, NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE
      SET notification_emails = ${emails.join(',') || null},
          notification_sms_numbers = ${phones.join(',') || null},
          text_notifications_enabled = ${textNotificationsEnabled},
          updated_at = NOW()
  `
  return { carried: true, reason: `Carried over ${emails.length} email(s), ${phones.length} phone(s).` }
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

// ── Closed-days / holiday carry-over on conversion ────────────────────────────
// Same access-control wall confirmed for notifications (2026-08-11, Francesca
// Catering - Glen Rock): FM's real closed-days/holiday config lives behind
// GET /api/closedDays, session-scoped to the restaurant's own login. The
// service account (getFmServiceAuthHeader) returns HTTP 200 with an EMPTY
// array for ANY restaurant, including Glen Rock, which we independently
// confirmed (via screenshots) has 5 real holidays + a custom vacation range
// configured. Because the failure mode is a "successful" empty array, not an
// error status, an empty result is treated as the SAME confirmed wall, not as
// "this restaurant genuinely has zero closures" — trusting an empty array at
// face value would silently reproduce the exact gap this function exists to
// close. Attempted anyway (in case FM ever exposes this to service accounts);
// every failure (including the empty-array case) both logs loudly AND
// persists the needs-review flag, so the gap is visible to an admin.
//
// FM's response shape for a NON-EMPTY result is UNVERIFIED — we have never
// actually seen one (every real attempt has returned []). Field names are
// inferred from disco-closed-days' own shape (holiday/name/fromDate/toDate in
// FM's camelCase convention, matching every other FM DTO in this codebase) and
// from the assumption that FM's model splits the same way Disco's does: named
// holidays (pre-computed recurring dates) vs. one-off custom ranges. If FM's
// real shape ever becomes reachable and differs, this will need adjusting —
// the empty-array guard above means it fails safe (flagged, not silently
// wrong) rather than inserting garbage.
export async function carryOverClosedDays(ref: string): Promise<ClosedDaysCarryOverResult> {
  const fail = async (reason: string): Promise<ClosedDaysCarryOverResult> => {
    console.error(`[convertToNative] closed-days carry-over FAILED for ${ref}: ${reason}`)
    await flagClosedDaysNeedReview(ref)
    return { carried: false, reason }
  }

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
    return fail(`FM /api/closedDays unreachable via service account (HTTP ${res.status}): ${body.slice(0, 200)} — this is the known session-scoped access-control wall; real closed dates must be entered manually post-conversion.`)
  }

  let data: unknown = null
  try { data = await res.json() } catch { /* fall through to the reason below */ }
  if (!Array.isArray(data)) {
    return fail('FM /api/closedDays returned a non-array body — cannot carry over.')
  }
  if (data.length === 0) {
    return fail('FM /api/closedDays returned an empty array — the confirmed access-control wall (a restaurant known to have real closures still returns []), not evidence this restaurant has none. Real closed dates must be entered manually.')
  }

  type FmClosedDay = { holiday?: string | null; name?: string | null; fromDate?: string | null; toDate?: string | null }
  const rows = data as FmClosedDay[]
  const thisYear = new Date().getFullYear()
  const inserts: { name: string; holiday: string | null; from: string; to: string }[] = []
  let skipped = 0

  for (const row of rows) {
    const holiday = row.holiday && isHolidayName(row.holiday) ? row.holiday : null
    if (holiday) {
      // Pre-compute the recurring run of dates, same as the manual holiday
      // toggle (app/api/restaurant/disco-closed-days) — matches Disco's model
      // regardless of whether FM sent explicit dates for a named holiday.
      for (const d of holidayDates(holiday, thisYear)) inserts.push({ name: holiday, holiday, from: d, to: d })
    } else if (row.fromDate && row.toDate) {
      inserts.push({ name: row.name || 'Closed', holiday: null, from: row.fromDate, to: row.toDate })
    } else {
      skipped++
    }
  }

  if (inserts.length === 0) {
    return fail(`FM /api/closedDays returned ${rows.length} row(s) but none were usable (unrecognized holiday name or missing dates) — cannot carry over.`)
  }

  // Replace wholesale rather than merge — this only ever runs once, at
  // conversion, against a restaurant that (per the gate above) has zero rows.
  await sql`DELETE FROM disco_restaurant_closed_days WHERE restaurant_reference = ${ref}::uuid`
  const holidayNames = new Set<string>()
  const stmts = inserts.map(i => {
    if (i.holiday) holidayNames.add(i.holiday)
    return sql`
      INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, holiday, from_date, to_date)
      VALUES (${ref}::uuid, ${i.name}, ${i.holiday}, ${i.from}::date, ${i.to}::date)
    `
  })
  await sql.transaction(stmts)
  return {
    carried: true,
    reason: `Carried over ${holidayNames.size} holiday(s) [${[...holidayNames].join(', ')}] + ${inserts.length - [...holidayNames].reduce((n, h) => n + holidayDates(h, thisYear).length, 0)} custom range(s) from ${rows.length} FM row(s)${skipped ? ` (${skipped} skipped — unusable)` : ''}.`,
  }
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

// Perform the flip — ONLY when every blocking step passes. Sets BOTH
// is_disco_native and is_live true: convertToNative's own gates (Stripe reuse
// LIVE-verified, native menu imported, marketplace-visibility rule) already cover
// everything goLiveNativeRestaurant's non-manual gates check, so a restaurant
// converted through this path goes immediately live to customers — no separate
// go-live step required. Visibility is left as-is otherwise (the marketplace-ready
// gate guarantees it stays visible if it was). Never flips a restaurant that isn't
// ready.
//
// NOTE: this intentionally does NOT verify goLiveNativeRestaurant's two
// real-action gates (a real live-mode $1 charge actually settling; a real signed
// Expedite dispatch for 3P-delivery restaurants) — those can't be inferred
// passively and require an actual recorded action. Skipping them here is a
// deliberate product decision (this comment exists so it's visible, not silent).
export async function convertToNative(ref: string, opts?: { stripe?: Stripe }): Promise<ConversionResult> {
  const readiness = await checkConversionReadiness(ref, opts)
  if (!readiness.found) return { converted: false, reason: 'Restaurant not found.', readiness }
  if (readiness.isDiscoNative) return { converted: false, reason: 'Already Disco-native.', readiness }
  if (!readiness.ready) {
    const failing = readiness.steps.filter(s => s.blocking && !s.done).map(s => s.label).join(', ')
    return { converted: false, reason: `Not ready — resolve: ${failing}.`, readiness }
  }
  // Gated prerequisite: backfill the restaurant's FULL FM order history into Neon
  // BEFORE flipping, so lead-gen fee tiers carry over for returning customers. If FM
  // is unreachable, do NOT convert — better to retry than flip without history (which
  // would silently reset every returning customer to fee-1).
  const backfill = await backfillFmOrderHistory(ref)
  if (!backfill.ok) {
    return { converted: false, reason: `FM order-history backfill failed (${backfill.error || 'unknown'}) — not converting; retry once FM is reachable.`, readiness }
  }
  await sql`UPDATE disco_restaurant_cache SET is_disco_native = true, is_live = true, cached_at = NOW() WHERE restaurant_reference = ${readiness.restaurantReference}`

  // Best-effort — a failed invite email or notification-carry-over must never
  // undo or fail an already-successful conversion. Restaurant name for the email
  // body comes from the cache row already confirmed to exist above.
  let invite: InviteResult | undefined
  try {
    const nameRow = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${readiness.restaurantReference} LIMIT 1`) as { name: string | null }[]
    invite = await ensureRestaurantLoginInvited(readiness.restaurantReference, nameRow[0]?.name ?? null)
  } catch (e) {
    invite = { invited: false, email: null, reason: `Invite step threw: ${e instanceof Error ? e.message : e}` }
  }

  // Best-effort, same contract as `invite` above — covers FM SYSTEM_ADMINs that
  // the single per-restaurant admin field never surfaces (see
  // inviteFmSystemAdminsFor's header comment). A failure here must never affect
  // `invite` above, the conversion itself, or any other step below.
  let systemAdminInvites: SystemAdminInviteResult[] = []
  try {
    const nameRow = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${readiness.restaurantReference} LIMIT 1`) as { name: string | null }[]
    systemAdminInvites = await inviteFmSystemAdminsFor(readiness.restaurantReference, nameRow[0]?.name ?? null)
  } catch (e) {
    console.error(`[convertToNative] system-admin invite step threw: ${e instanceof Error ? e.message : e}`)
  }

  let notificationSettings: NotificationCarryOverResult
  try {
    notificationSettings = await carryOverNotificationSettings(readiness.restaurantReference)
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
    closedDays = await carryOverClosedDays(readiness.restaurantReference)
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

  return { converted: true, readiness: { ...readiness, isDiscoNative: true, isLive: true }, invite, systemAdminInvites, notificationSettings, closedDays, promoCodes }
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
  opts?: { stripe?: Stripe; email?: string },
): Promise<ImportResult> {
  await runMigrations()
  const check = await verifyAccountReusable(accountId, opts?.stripe)

  const existing = (await sql`
    SELECT id FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref} LIMIT 1
  `.catch(() => [])) as { id: number }[]

  if (existing.length) {
    await sql`
      UPDATE disco_restaurant_accounts
      SET stripe_account_id = ${accountId}, stripe_onboarding_complete = ${check.reusable}, updated_at = NOW()
      WHERE id = ${existing[0].id}
    `
  } else {
    // No Disco account row yet (pure FM restaurant). Create a login-disabled holder
    // row so native checkout can resolve the connected account. password_hash is a
    // valid bcrypt hash of a random value → login impossible until a real reset.
    const sentinel = bcrypt.hashSync(randomUUID(), 10)
    const email = opts?.email || `stripe-import+${ref}@familymeal.com`
    await sql`
      INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, fm_restaurant_reference, stripe_account_id, stripe_onboarding_complete, role, is_disco_native)
      VALUES (${email}, ${sentinel}, ${ref}, ${ref}, ${accountId}, ${check.reusable}, 'ADMIN', false)
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
