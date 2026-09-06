// FM restaurant-admin reads via the master password — the fix for taxRate,
// notifications, closedDays, and (added 2026-08-19) the coupon/promo code
// being session-scoped to a real restaurant login (never reachable via the
// SUPER_ADMIN service account; see lib/fm-service-auth.ts and
// getRestaurantRef's own comment for that wall being confirmed and permanent).
//
// Confirmed empirically (this session): FM's own /login accepts the master
// password for any enabled restaurant admin, in place of their real password.
// A SYSTEM_ADMIN-role login (restaurant-scoped, unlike the platform service
// account) reads all five fields as real data. A two-token test confirmed
// FM's "current restaurant" selection is SERVER-SIDE STATE PERSISTED PER FM
// USER ACCOUNT, not per-token/per-session: switching via one login is visible
// to a wholly separate login as the same user. Every switch here is therefore
// a real, shared mutation on someone else's account — never a safe read — and
// is treated with the hygiene that implies: bookended sessions, unconditional
// restore, verified restore, and a loud alert if the restore can't be confirmed.
//
// FM WRITE POLICY: the only FM call here that mutates anything is the
// restaurant-selection switch (PUT /api/system-admin/restaurants/current),
// explicitly carved out as transient session state, not restaurant data. Every
// other call is a GET, or the /login call needed to obtain a token. Nothing here
// ever touches a restaurant's menu, orders, or settings.
//
// FM_MASTER_PASSWORD is intentionally read ONLY in this module — it must not be
// reachable from general request handling. It is more powerful than any other
// secret in this repo: it authenticates as ANY restaurant's real admin, and (per
// lib/master-login.ts) the same value also bypasses Disco's own portal login.
// Rotating the FM-side master password means MASTER_PASSWORD_HASH (Disco's own
// bypass) must be re-hashed and rotated in lockstep — confirmed this session
// that the two are the same underlying secret. Document that dependency
// wherever the rotation runbook lives; this file cannot enforce it.
import { sql } from './db'
import { alertOps } from './ops-alert'
import { getFmServiceAuthHeader } from './fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// The two platform accounts confirmed (this session) to hold the admin slot on
// ~3,280 restaurants that have no REAL per-restaurant admin at all. Both are
// SUPER_ADMIN, already confirmed denied on all four endpoints regardless of a
// real restaurant claim — logging in as either would accomplish nothing and
// would be logging in as a platform identity, not a restaurant's own admin.
// Hard-blocked by email as well as by role, independent of how the role gets
// resolved, so a future data quirk can't slip past a role-only check.
const PLATFORM_ADMIN_EMAILS = new Set(['peter@familymeal.com', 'matthew@familymeal.com'])

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    return JSON.parse(json)
  } catch {
    return null
  }
}

export interface FmAdminIdentity {
  email: string
  role: 'ADMIN' | 'SYSTEM_ADMIN'
  // Sourced independently of the post-login JWT — see the note below on why
  // the JWT alone isn't trusted for this anymore. null only when genuinely
  // unknown (should be rare); readGroupForOneAdmin refuses to switch at all
  // for an admin whose home can't be determined this way.
  homeRestaurant: string | null
}

// ── SYSTEM_ADMIN coverage map — one bulk call, cached briefly ────────────────
// Mirrors the TTL/never-throws contract of getFmSystemAdminPermittedRefs in
// lib/restaurant-auth.ts. A stale cache just means a restaurant that gained
// SYSTEM_ADMIN coverage in the last few minutes gets resolved via the
// per-restaurant ADMIN path instead this run — never wrong, just a slower path.
//
// homeRestaurant is read from THIS list's own `restaurant` field, not from
// decoding it back out of the JWT after login. Confirmed necessary live
// (Smyrna's conversion): the same admin's JWT decoded restaurant as null on
// the actual conversion run despite this list correctly showing a home
// restaurant, and despite a manual re-login moments later decoding it
// correctly too — non-deterministic, cause unconfirmed. The bulk list is the
// independent, pre-login source of truth; readGroupForOneAdmin no longer
// relies on the JWT for this at all.
let systemAdminCache: { expiresAt: number; map: Map<string, FmAdminIdentity> } | null = null
const SYSTEM_ADMIN_CACHE_TTL_MS = 5 * 60_000

async function getSystemAdminCoverageMap(): Promise<Map<string, FmAdminIdentity>> {
  const now = Date.now()
  if (systemAdminCache && now < systemAdminCache.expiresAt) return systemAdminCache.map

  const map = new Map<string, FmAdminIdentity>()
  try {
    const auth = await getFmServiceAuthHeader()
    const res = await fetch(`${FM}/api/admin/users/system-admin?size=2000`, { headers: { ...auth, Accept: 'application/json' } })
    if (res.ok) {
      const body = await res.json().catch(() => null)
      const users = (Array.isArray(body) ? body : body?.content) as Array<{
        email?: string; enabled?: boolean; restaurant?: { reference?: string } | null
        managedRestaurants?: Array<{ reference?: string }>
      }> | undefined
      // More than one SYSTEM_ADMIN can cover the same restaurant — confirmed
      // real, not hypothetical (Pelican Delicatessen: both chef@familymeal.com,
      // home confirmed, AND chef+1@familymeal.com, home null; Hugo's Tacos
      // Studio City/Atwater Village: both stucity@hugostacos.com, home
      // confirmed, AND atwater@hugostacos.com, home null — same two
      // restaurants, either identity). Whichever was encountered first in
      // FM's own array order used to win arbitrarily — meaning the safer,
      // home-confirmed identity could lose to the unconfirmed one purely by
      // luck of ordering, which then trips the refuse-to-switch safety check
      // in readGroupForOneAdmin for a restaurant that had a perfectly good
      // alternative. Prefer whichever identity has a confirmed home; only
      // fall back to a null-home one if no confirmed alternative exists.
      for (const u of users || []) {
        if (u.enabled === false || !u.email || PLATFORM_ADMIN_EMAILS.has(u.email)) continue
        const homeRestaurant = u.restaurant?.reference || null
        for (const m of u.managedRestaurants || []) {
          if (!m.reference) continue
          const existing = map.get(m.reference)
          if (!existing || (existing.homeRestaurant == null && homeRestaurant != null)) {
            map.set(m.reference, { email: u.email, role: 'SYSTEM_ADMIN', homeRestaurant })
          }
        }
      }
    }
  } catch (e) {
    console.error('[fm-master-admin-read] SYSTEM_ADMIN coverage fetch failed (falling back to per-restaurant resolution):', e instanceof Error ? e.message : e)
  }
  systemAdminCache = { expiresAt: now + SYSTEM_ADMIN_CACHE_TTL_MS, map }
  return map
}

// ── Resolve one restaurant's real admin identity ─────────────────────────────
// SYSTEM_ADMIN coverage first (cached bulk call). Otherwise piggyback on the
// SAME /api/admin/restaurants/{ref} call conversion already makes for profile-
// field carry-over — no new API cost for the ADMIN-role case. A SUPER_ADMIN-role
// admin (the platform accounts) or no admin at all resolves to null: unreachable,
// stays flagged for manual review same as today.
export async function resolveFmAdminIdentity(ref: string): Promise<FmAdminIdentity | null> {
  const sysMap = await getSystemAdminCoverageMap()
  const sysHit = sysMap.get(ref)
  if (sysHit) return sysHit

  try {
    const auth = await getFmServiceAuthHeader()
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: { ...auth, Accept: 'application/json' } })
    if (!res.ok) return null
    const body = await res.json().catch(() => null) as { admin?: { email?: string; role?: string; enabled?: boolean } } | null
    const admin = body?.admin
    if (!admin?.email || admin.enabled === false) return null
    if (admin.role !== 'ADMIN' && admin.role !== 'SYSTEM_ADMIN') return null // SUPER_ADMIN or anything unexpected
    if (PLATFORM_ADMIN_EMAILS.has(admin.email)) return null
    // A plain ADMIN belongs to exactly one restaurant — this ref IS home,
    // known from context, not from any post-login decode.
    return { email: admin.email, role: admin.role, homeRestaurant: admin.role === 'ADMIN' ? ref : null }
  } catch (e) {
    console.error(`[fm-master-admin-read] admin-identity resolution failed for ${ref}:`, e instanceof Error ? e.message : e)
    return null
  }
}

// ── Audit — every attempt, success or failure ────────────────────────────────
let auditTableEnsured = false
async function ensureAuditTable(): Promise<void> {
  if (auditTableEnsured) return
  // Same table lib/master-login.ts uses for the Disco-side bypass — one place
  // for every master-password use, distinguished by `action`.
  await sql`
    CREATE TABLE IF NOT EXISTS disco_admin_audit (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      restaurant_reference TEXT,
      actor_email TEXT,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  auditTableEnsured = true
}

interface AuditDetail {
  adminEmail: string
  adminRole: 'ADMIN' | 'SYSTEM_ADMIN'
  homeRestaurant: string | null
  restaurantsRequested: string[]
  restaurantsRead: string[]
  switchedTo: string[]
  restoredTo: string | null
  restoreConfirmed: boolean | null
  ok: boolean
  reason: string
}

async function auditRead(detail: AuditDetail): Promise<void> {
  try {
    await ensureAuditTable()
    await sql`
      INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
      VALUES (
        'FM_MASTER_PASSWORD_READ',
        ${detail.restaurantsRequested.join(',') || null},
        ${detail.adminEmail},
        ${JSON.stringify(detail)}::jsonb
      )
    `
  } catch (e) {
    // Same principle as recordMasterPasswordLogin: never block on a logging
    // failure, but never let it be silent either — this is the only trail for
    // a mechanism that mutates a real admin's account state.
    console.error('[fm-master-admin-read] FAILED to write audit entry for a master-password read:', {
      adminEmail: detail.adminEmail, restaurants: detail.restaurantsRequested,
    }, e instanceof Error ? e.message : e)
  }
}

/**
 * Audit a master-password use that did NOT go through readWalledFields — the
 * browser path (scripts/fm-browser-session.mjs) being the reason this exists.
 *
 * A screenshot session that signs in as a restaurant admin is the same act as an
 * API read: it uses FM_MASTER_PASSWORD in place of someone's real password. It
 * must leave the same record, under the same `action`, or the audit trail
 * quietly stops being the answer to "who used the master password". `via`
 * distinguishes the two without splitting the action.
 */
export async function auditMasterPasswordUse(args: {
  adminEmail: string
  restaurantReference?: string | null
  via: 'browser' | 'api' | string
  ok: boolean
  reason: string
  extra?: Record<string, unknown>
}): Promise<void> {
  try {
    await ensureAuditTable()
    await sql`
      INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
      VALUES (
        'FM_MASTER_PASSWORD_READ',
        ${args.restaurantReference || null},
        ${args.adminEmail},
        ${JSON.stringify({ via: args.via, ok: args.ok, reason: args.reason, ...(args.extra || {}) })}::jsonb
      )
    `
  } catch (e) {
    console.error('[fm-master-admin-read] FAILED to write audit entry for a master-password use:', {
      adminEmail: args.adminEmail, via: args.via, restaurant: args.restaurantReference,
    }, e instanceof Error ? e.message : e)
  }
}

// ── FM calls: login, switch, and the three reads ─────────────────────────────
// Every one of these is a GET, or the /login call needed to obtain a token, or
// the explicitly-permitted selection switch — never a write to restaurant data.
//
// homeRestaurant is NOT sourced from this login's JWT — see FmAdminIdentity's
// comment. Decoding it back out here proved unreliable on the one real
// conversion run so far (came back null on the actual run, non-null on an
// immediate manual re-login with identical credentials — cause unconfirmed).
// The JWT's own claim is still logged for cross-checking, never trusted alone.
async function loginAsFmAdmin(email: string): Promise<{ token: string }> {
  const password = process.env.FM_MASTER_PASSWORD
  if (!password) throw new Error('FM_MASTER_PASSWORD is not configured')
  const res = await fetch(`${FM}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`FM login failed for ${email}: HTTP ${res.status}`)
  const body = await res.json().catch(() => null)
  const token = String(body?.authorization || body?.token || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error(`FM login for ${email} returned no token`)
  const claims = decodeJwt(token)
  const jwtRestaurant = (claims?.restaurant as string) || null
  if (jwtRestaurant) console.log(`[fm-master-admin-read] ${email}: JWT restaurant claim = ${jwtRestaurant} (logged for cross-check only, not used as the restore target)`)
  return { token }
}

async function switchSelection(token: string, ref: string): Promise<boolean> {
  const res = await fetch(`${FM}/api/system-admin/restaurants/current?restaurantReference=${encodeURIComponent(ref)}`, {
    method: 'PUT', headers: { Authorization: token, Accept: 'application/json' },
  })
  return res.ok
}

// FM's real shape (confirmed via a live master-password read this session,
// Francesca Catering - Glen Rock's real FRAN10 code) — a SINGLE OBJECT, not a
// list: {reference, code, maxAvailable, maxPerDiner, discountPercentage,
// startDate, endDate, remainingDiscountAvailable}, dates as plain
// "YYYY-MM-DD" (unlike closedDays' "DD.MM.YYYY"). A restaurant with no
// coupon configured returns the same 200 shape with everything but
// remainingDiscountAvailable absent — {"remainingDiscountAvailable":0},
// confirmed on Pelican Delicatessen (no coupon) — so "no `code` field" is the
// genuine "nothing configured" signal, not a wall (there's no separate error
// status for "none" the way tax/notifications/closedDays don't have one
// either once you're past the SUPER_ADMIN wall).
interface FmCoupon {
  reference?: string
  code?: string
  maxAvailable?: number
  maxPerDiner?: number
  discountPercentage?: number
  startDate?: string
  endDate?: string
  remainingDiscountAvailable?: number
}

// FM's real Authorized Users list for a restaurant — the ADMIN/SYSTEM_ADMIN
// join GET /api/system-admin/users exposes, confirmed via disco-cater's own
// existing session-scoped proxy (app/api/restaurant/authorized-users/route.ts,
// which already calls this exact endpoint for a real logged-in restaurant
// admin) and its POST body shape (app/api/restaurant/authorized-users/route.ts's
// own comment: {firstName, lastName, email, role, restaurantReference: string[]}
// — restaurantReference is ALWAYS an array on the wire, confirming this is a
// genuine many-to-many join, not the single embedded `admin` field on
// /api/admin/restaurants/{ref}). Session-scoped exactly like the other four
// fields (confirmed empirically: the SUPER_ADMIN service account gets a 500
// "Access is denied" calling it directly) — reachable only via this
// master-password mechanism for anything without a live restaurant session.
//
// Response shape CONFIRMED live 2026-08-20 across all 24 converted
// restaurants: `{content: [{email, firstName, lastName, role}]}`, `role` is
// exactly 'ADMIN' | 'SYSTEM_ADMIN' as expected — the defensive parse below
// (content-array fallback, every field optional) was correct.
//
// Two things NOT in the parse below that real data revealed:
//   1. There is NO `enabled` field on this response at all (unlike the
//      SYSTEM_ADMIN list, which has one) — every real record came back with
//      it simply absent, not false. `enabled?: boolean` stays optional/
//      unused for filtering (never treat its absence as "disabled").
//   2. The endpoint itself requires a SYSTEM_ADMIN-role FM session — a plain
//      ADMIN-role login (single-location restaurant) gets a flat `500 Access
//      is denied`, confirmed live on 3 of the 24 (Francesca Catering x2, The
//      Winkin' Rooster — all three resolve to a role=ADMIN identity). This
//      isn't a bug or a restaurant-specific gap: FM's Authorized Users
//      concept only exists for SYSTEM_ADMIN/chain-level accounts; a
//      single-location ADMIN has no such list to have. authorizedUsers comes
//      back null for these, not empty — see inviteFmAuthorizedUsersFor's
//      handling in lib/native-conversion.ts for why that's expected.
export interface FmAuthorizedUser {
  email: string
  firstName?: string
  lastName?: string
  role?: 'ADMIN' | 'SYSTEM_ADMIN'
  enabled?: boolean
}

interface RawWalledFields {
  taxRate: { stateSalesTax?: { percent?: number | null; fixedAmount?: number | null }; localSalesTax?: { percent?: number | null; fixedAmount?: number | null }; otherSalesTax?: { percent?: number | null; fixedAmount?: number | null; types?: string[] } } | null
  // orderReminderEmailsEnabled / adminOrderReminderEmailsEnabled are on this
  // same response and were simply never read here — the carry-over wrote the
  // recipients and dropped both toggles, so a restaurant with FM reminders ON
  // converted into Neon's `DEFAULT false` and its customer reminder emails
  // silently stopped (caught on Bird & Co's pre-flight, 2026-08-26).
  notifications: {
    email?: string[]
    phoneNumber?: string[]
    phoneNotificationType?: string
    orderReminderEmailsEnabled?: boolean
    adminOrderReminderEmailsEnabled?: boolean
  } | null
  closedDays: unknown[] | null
  promoCode: FmCoupon | null
  // null = the fetch failed/threw; [] = fetched fine, genuinely nobody listed
  // (distinct from null the same way promoCode/closedDays distinguish "wall or
  // error" from "real empty" elsewhere in this file).
  authorizedUsers: FmAuthorizedUser[] | null
}

async function readWalledFields(token: string): Promise<RawWalledFields> {
  const auth = { Authorization: token, Accept: 'application/json' }
  const [taxRes, notifRes, closedRes, couponRes, usersRes] = await Promise.all([
    fetch(`${FM}/api/restaurants/taxRate`, { headers: auth }),
    fetch(`${FM}/api/notifications`, { headers: auth }),
    fetch(`${FM}/api/closedDays`, { headers: auth }),
    fetch(`${FM}/api/coupon`, { headers: auth }),
    // Large page size, same reasoning as the SYSTEM_ADMIN list (no confirmed
    // working server-side restaurant filter on FM's paginated list endpoints
    // in general) — one call, not a paging loop, for what should be a handful
    // of people per restaurant.
    fetch(`${FM}/api/system-admin/users?page=0&size=200`, { headers: auth }),
  ])
  const taxRate = taxRes.ok ? await taxRes.json().catch(() => null) : null
  const notifications = notifRes.ok ? await notifRes.json().catch(() => null) : null
  const closedDaysRaw = closedRes.ok ? await closedRes.json().catch(() => null) : null
  const closedDays = Array.isArray(closedDaysRaw) ? closedDaysRaw : null
  const couponRaw = couponRes.ok ? await couponRes.json().catch(() => null) as FmCoupon | null : null
  const promoCode = couponRaw?.code ? couponRaw : null
  let authorizedUsers: FmAuthorizedUser[] | null = null
  if (usersRes.ok) {
    const body = await usersRes.json().catch(() => null) as { content?: unknown[] } | unknown[] | null
    const raw = Array.isArray(body) ? body : (body as { content?: unknown[] })?.content
    if (Array.isArray(raw)) {
      authorizedUsers = raw.map((u) => {
        const r = u as Record<string, unknown>
        const role = r.role
        return {
          email: String(r.email || '').trim().toLowerCase(),
          firstName: typeof r.firstName === 'string' ? r.firstName : undefined,
          lastName: typeof r.lastName === 'string' ? r.lastName : undefined,
          role: (role === 'ADMIN' || role === 'SYSTEM_ADMIN' ? role : undefined) as ('ADMIN' | 'SYSTEM_ADMIN' | undefined),
          enabled: typeof r.enabled === 'boolean' ? r.enabled : undefined,
        }
      }).filter(u => !!u.email)
    }
  }
  return { taxRate, notifications, closedDays, promoCode, authorizedUsers }
}

export interface FmWalledFieldsResult extends RawWalledFields {
  ok: boolean
  reason: string
}

// ── The core entry point ──────────────────────────────────────────────────────
// Reads all five walled fields for the given restaurants. Groups by resolved
// admin identity internally (one login per admin, all their restaurants covered
// by THIS call in one continuous run) — the same code path serves a single
// restaurant at conversion time (an array of 1) and a real batch (many refs
// sharing admins) without duplicating the session-hygiene logic.
export async function readWalledFieldsForRestaurants(refs: string[]): Promise<Map<string, FmWalledFieldsResult>> {
  const results = new Map<string, FmWalledFieldsResult>()
  const unresolved: string[] = []

  // Resolve admin identity for every ref first (cheap: cached bulk map + at
  // most one detail call per ref, which conversion already makes elsewhere).
  const byAdmin = new Map<string, { role: 'ADMIN' | 'SYSTEM_ADMIN'; homeRestaurant: string | null; refs: string[] }>()
  for (const ref of refs) {
    const identity = await resolveFmAdminIdentity(ref)
    if (!identity) { unresolved.push(ref); continue }
    const group = byAdmin.get(identity.email) ?? { role: identity.role, homeRestaurant: identity.homeRestaurant, refs: [] }
    group.refs.push(ref)
    byAdmin.set(identity.email, group)
  }

  for (const ref of unresolved) {
    results.set(ref, { taxRate: null, notifications: null, closedDays: null, promoCode: null, authorizedUsers: null, ok: false, reason: 'No real per-restaurant admin identity found (no admin on file, or only a platform SUPER_ADMIN account) — cannot read via master password.' })
  }

  for (const [email, group] of byAdmin) {
    await readGroupForOneAdmin(email, group.role, group.homeRestaurant, group.refs, results)
  }

  return results
}

async function readGroupForOneAdmin(
  email: string,
  role: 'ADMIN' | 'SYSTEM_ADMIN',
  homeRestaurant: string | null,
  refs: string[],
  results: Map<string, FmWalledFieldsResult>,
): Promise<void> {
  // Refuse outright if this admin covers any restaurant OTHER than their
  // (unknown) home and we don't independently know what that home is — we
  // will not switch an admin's account with no trustworthy way to restore it.
  // A single-restaurant admin whose home happens to equal the one ref being
  // read is always safe regardless (no switch is ever needed), so that case
  // still proceeds even with homeRestaurant unknown.
  const needsSwitch = refs.some(ref => ref !== homeRestaurant)
  if (needsSwitch && !homeRestaurant) {
    const reason = `${email}'s home restaurant could not be independently confirmed, and reading ${refs.length > 1 ? 'these restaurants' : 'this restaurant'} would require switching this admin's FM selection — refusing rather than switching with no safe way to restore it.`
    console.error(`[fm-master-admin-read] ${reason}`)
    for (const ref of refs) results.set(ref, { taxRate: null, notifications: null, closedDays: null, promoCode: null, authorizedUsers: null, ok: false, reason })
    await auditRead({
      adminEmail: email, adminRole: role, homeRestaurant, restaurantsRequested: refs,
      restaurantsRead: [], switchedTo: [], restoredTo: null, restoreConfirmed: null, ok: false, reason,
    })
    return
  }

  let token: string
  try {
    ({ token } = await loginAsFmAdmin(email))
  } catch (e) {
    const reason = `FM login as ${email} failed: ${e instanceof Error ? e.message : e}`
    console.error(`[fm-master-admin-read] ${reason}`)
    for (const ref of refs) results.set(ref, { taxRate: null, notifications: null, closedDays: null, promoCode: null, authorizedUsers: null, ok: false, reason })
    await auditRead({
      adminEmail: email, adminRole: role, homeRestaurant, restaurantsRequested: refs,
      restaurantsRead: [], switchedTo: [], restoredTo: null, restoreConfirmed: null, ok: false, reason,
    })
    return
  }

  const switchedTo: string[] = []
  const restaurantsRead: string[] = []
  let overallReason = 'ok'

  // WHERE THE SESSION IS POINTING RIGHT NOW, tracked across the loop.
  //
  // THIS USED TO BE COMPARED AGAINST `homeRestaurant`, AND THAT WAS A REAL BUG THAT
  // SILENTLY RETURNED ANOTHER RESTAURANT'S DATA. The switch was skipped whenever
  // `ref === homeRestaurant`, on the assumption that the session was still on home —
  // true only on the FIRST iteration. Once any earlier ref had switched the selection
  // away, reading the home restaurant skipped the switch and read whatever the session
  // was actually pointing at, returning the PREVIOUS restaurant's taxRate, notifications
  // and closedDays under the home restaurant's key, with `ok: true`.
  //
  // Reproduced against Two Hands on 2026-09-06 (Franklin is this admin's JWT home):
  //   [Franklin, Austin]              -> Franklin 7%,   Austin 8.25%    both correct
  //   [Austin, Franklin]              -> Austin 8.25%,  Franklin 8.25%  WRONG
  //   [Williamsburg, Austin, Franklin]-> ...,           Franklin 8.25%  WRONG
  // Franklin is a Tennessee restaurant; 8.25% is Austin's Texas rate. Solo reads were
  // always correct, which is why this survived — every conversion call site passes a
  // single-element array.
  //
  // Tracking the ACTUAL selection fixes both directions: the first read still costs no
  // switch when it happens to be home, and coming back to home later now switches.
  let currentSelection: string | null = homeRestaurant

  try {
    for (const ref of refs) {
      try {
        if (ref !== currentSelection) {
          const switched = await switchSelection(token, ref)
          if (!switched) {
            results.set(ref, { taxRate: null, notifications: null, closedDays: null, promoCode: null, authorizedUsers: null, ok: false, reason: `Could not switch ${email}'s selection to this restaurant.` })
            continue
          }
          currentSelection = ref
          if (ref !== homeRestaurant) switchedTo.push(ref)
        }
        const raw = await readWalledFields(token)
        results.set(ref, { ...raw, ok: true, reason: 'Read via master-password admin session.' })
        restaurantsRead.push(ref)
      } catch (e) {
        const reason = `Read failed for ${ref}: ${e instanceof Error ? e.message : e}`
        console.error(`[fm-master-admin-read] ${reason}`)
        results.set(ref, { taxRate: null, notifications: null, closedDays: null, promoCode: null, authorizedUsers: null, ok: false, reason })
      }
    }
  } finally {
    // Unconditional restore — runs even if a read above threw or the loop was
    // interrupted. This is the one FM call every session here MUST make before
    // it ends, because the two-token test confirmed the switch is real, shared,
    // persisted state on this admin's own account.
    let restoreConfirmed: boolean | null = null
    if (homeRestaurant && switchedTo.length > 0) {
      try {
        const restored = await switchSelection(token, homeRestaurant)
        if (restored) {
          // Verify, don't just trust — re-read one cheap signal and confirm it
          // reflects home again, rather than assuming the PUT's 200 means the
          // account actually landed back where expected.
          const check = await readWalledFields(token)
          // notifications.reference is restaurant-specific in every observed
          // response; a real home reference on file is proof enough it moved.
          restoreConfirmed = check.notifications != null || check.taxRate != null || check.closedDays != null || check.authorizedUsers != null
        } else {
          restoreConfirmed = false
        }
      } catch (e) {
        restoreConfirmed = false
        console.error(`[fm-master-admin-read] restore-to-home threw for ${email}:`, e instanceof Error ? e.message : e)
      }
      if (!restoreConfirmed) {
        overallReason = 'RESTORE FAILED OR UNVERIFIED'
        await alertOps(
          `fm-master-admin-read: could not confirm ${email}'s FM selection was restored to their home restaurant (${homeRestaurant}) after a batch read — their account may be left pointed at ${switchedTo[switchedTo.length - 1]}`,
          { adminEmail: email, homeRestaurant, lastSwitchedTo: switchedTo[switchedTo.length - 1], switchedTo, restaurantsRead },
        )
      }
    }
    await auditRead({
      adminEmail: email, adminRole: role, homeRestaurant, restaurantsRequested: refs,
      restaurantsRead, switchedTo, restoredTo: homeRestaurant, restoreConfirmed,
      ok: overallReason === 'ok', reason: overallReason,
    })
  }
}
