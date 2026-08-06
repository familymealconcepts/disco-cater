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
import { setInviteToken } from './disco-restaurant-auth'
import { sendTeamMemberInvite } from './email/notifications'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { sanitizePhone } from './utils/phone'

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

  // Settings: an overrides row with tax rates mirrored and online ordering not off.
  const ov = (await sql`
    SELECT tax_rates, online_ordering_enabled FROM disco_restaurant_overrides
    WHERE restaurant_reference = ${nativeRef} LIMIT 1
  `.catch(() => [])) as { tax_rates: unknown; online_ordering_enabled: boolean | null }[]
  const settingsOk = !!ov[0]?.tax_rates && ov[0]?.online_ordering_enabled !== false

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
    { key: 'settings', label: 'Settings populated', done: settingsOk, blocking: false, detail: settingsOk ? 'Tax rates mirrored; online ordering on.' : 'Populate tax rates and enable online ordering.' },
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
  notificationSettings?: NotificationCarryOverResult
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

export interface NotificationCarryOverResult {
  carried: boolean
  reason: string
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
// case that ever changes) and the failure is surfaced loudly rather than silently,
// exactly so a restaurant never converts with a silently-empty notification setup
// again without it being visible in the conversion result and the logs.
export async function carryOverNotificationSettings(ref: string): Promise<NotificationCarryOverResult> {
  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) {
    const reason = `FM auth failed — could not even attempt the notification-settings fetch: ${e instanceof Error ? e.message : e}`
    console.error(`[convertToNative] notification carry-over FAILED for ${ref}: ${reason}`)
    return { carried: false, reason }
  }

  let res: Response
  try {
    res = await fetch(`${FM}/api/notifications?restaurantReference=${ref}`, { headers: { ...auth, Accept: 'application/json' } })
  } catch (e) {
    const reason = `FM notification-settings request threw: ${e instanceof Error ? e.message : e}`
    console.error(`[convertToNative] notification carry-over FAILED for ${ref}: ${reason}`)
    return { carried: false, reason }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const reason = `FM /api/notifications unreachable via service account (HTTP ${res.status}): ${body.slice(0, 200)} — this is the known session-scoped access-control wall; real recipients must be entered manually post-conversion.`
    console.error(`[convertToNative] notification carry-over FAILED for ${ref}: ${reason}`)
    return { carried: false, reason }
  }

  // Unreachable today (confirmed above), kept for the day FM exposes a real path —
  // same NotificationsShape as app/api/restaurant/notifications' FM-token GET.
  let data: { email?: string[]; phoneNumber?: string[]; phoneNotificationType?: string } | null = null
  try { data = await res.json() } catch { /* fall through to the reason below */ }
  if (!data) {
    const reason = 'FM /api/notifications returned a non-JSON or empty body — cannot carry over.'
    console.error(`[convertToNative] notification carry-over FAILED for ${ref}: ${reason}`)
    return { carried: false, reason }
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

  return { converted: true, readiness: { ...readiness, isDiscoNative: true, isLive: true }, invite, notificationSettings }
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
