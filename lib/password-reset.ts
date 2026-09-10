import { sql } from './db'
import { setResetToken } from './disco-restaurant-auth'
import { sendPasswordReset } from './email/notifications'
import { logAdminAction } from './admin-audit'

const SITE_URL = 'https://www.discocater.com'

/**
 * THE password-reset flow. One implementation, two callers: the self-service
 * "Forgot password" route and the super-admin Users screen button.
 *
 * This used to live inline inside app/api/auth/forgot-password/route.ts. It is
 * extracted rather than copied because the token write and the email send are
 * the same act performed on someone's credentials, and two copies of that would
 * drift — the admin button would keep sending 1-hour tokens after the
 * self-service expiry changed, or send a differently-worded email.
 *
 * WHICH SYSTEM OWNS A LOGIN. Not "does the account have an FM reference" —
 * nearly every converted account has one and it decides nothing. A restaurant
 * account's password is checked against disco_restaurant_accounts.password_hash
 * only when its restaurant is native, so the deciding pair is:
 *
 *   disco_restaurant_cache.is_disco_native = true   (the authoritative flag)
 *   AND disco_restaurant_accounts.password_hash IS NOT NULL
 *
 * The cache flag, NOT disco_restaurant_accounts.is_disco_native: that column is
 * written once at account creation and never updated when the restaurant later
 * converts, so it goes stale. The forgot-password route already documents three
 * real accounts it silently misrouted. Reading it here would reintroduce that.
 */

export interface ResetTarget {
  email: string
  firstName: string | null
  restaurantName: string | null
  restaurantReference: string | null
  role: string
}

export type ResetEligibility =
  | { eligible: true; target: ResetTarget }
  | { eligible: false; reason: string }

/** Minutes a target must wait between delivered resets. */
export const RESET_COOLDOWN_MINUTES = 5

/**
 * Is this email a Disco-native login this platform can actually reset?
 *
 * Returns a short, user-facing `reason` when not, so the admin UI can disable
 * the control and say why instead of offering an action that cannot work.
 */
export async function resolveResetEligibility(email: string): Promise<ResetEligibility> {
  const e = (email || '').trim()
  if (!e) return { eligible: false, reason: 'No email on this account.' }

  const rows = (await sql`
    SELECT a.email, a.first_name, a.restaurant_name, a.restaurant_reference,
           COALESCE(a.role, 'ADMIN') AS role,
           (c.is_disco_native = true) AS native,
           (a.password_hash IS NOT NULL) AS has_password
    FROM disco_restaurant_accounts a
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = a.restaurant_reference
    WHERE lower(a.email) = lower(${e}) AND a.archived_at IS NULL
    ORDER BY a.id ASC
    LIMIT 1
  `) as Array<{
    email: string; first_name: string | null; restaurant_name: string | null
    restaurant_reference: string | null; role: string; native: boolean | null; has_password: boolean
  }>

  const acct = rows[0]
  if (acct) {
    if (acct.role.toUpperCase() === 'SUPER_ADMIN') {
      return { eligible: false, reason: 'Super admin accounts are out of scope.' }
    }
    if (!acct.native) return { eligible: false, reason: 'FamilyMeal owns this login.' }
    if (!acct.has_password) return { eligible: false, reason: 'No Disco password set yet — send an invite instead.' }
    return {
      eligible: true,
      target: {
        email: acct.email,
        firstName: acct.first_name,
        restaurantName: acct.restaurant_name,
        restaurantReference: acct.restaurant_reference,
        role: acct.role.toUpperCase(),
      },
    }
  }

  // Diners. Their password_hash lives in disco_customers and IS what
  // /api/fm-auth verifies (unless it is the FM_MIGRATED sentinel), so Disco does
  // own the credential — but there is no Disco reset flow for them:
  // disco_customers has no reset-token column and there is no customer-facing
  // set-password page. Offering the button here would mean inventing a second
  // flow, so it is disabled and says so.
  const cust = (await sql`
    SELECT 1 FROM disco_customers WHERE lower(email) = lower(${e}) LIMIT 1
  `) as unknown[]
  if (cust.length) return { eligible: false, reason: 'No Disco reset flow for diner accounts yet.' }

  return { eligible: false, reason: 'No Disco account for this email.' }
}

export type ResetOutcome =
  // `audited: false` means the email WENT OUT but the trail row did not land.
  // Surfaced rather than swallowed because that row is load-bearing twice over:
  // it is the record of an action taken on someone else's credentials, and it
  // is the storage the cooldown below reads — losing it silently would remove
  // the rate limit as well as the audit.
  | { ok: true; audited: boolean }
  | { ok: false; code: 'rate-limited' | 'send-failed'; message: string }

/** Delivered resets for this target inside the cooldown window. */
async function recentlySent(email: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT 1 FROM disco_admin_audit
      WHERE action = 'password_reset_sent'
        AND lower(detail->>'targetEmail') = lower(${email})
        AND created_at > NOW() - (${RESET_COOLDOWN_MINUTES} || ' minutes')::interval
      LIMIT 1
    `) as unknown[]
    return rows.length > 0
  } catch (e) {
    // A limiter that cannot read its own history must not silently become "no
    // limit" — refuse instead, and say so through the caller.
    console.error('[password-reset] cooldown check failed:', e instanceof Error ? e.message : e)
    throw e
  }
}

/**
 * Issue a token and send THE reset email — the same token, expiry, storage and
 * template a user gets from "Forgot password". Never returns success unless the
 * mailer reported the message dispatched.
 *
 * The audit row is written only on a delivered send, which is deliberate: it is
 * both the trail and the rate-limiter's storage, so a failed send neither
 * claims to have happened nor locks the target out of an immediate retry.
 */
export async function sendPasswordResetTo(
  target: ResetTarget,
  opts: { source: 'self-service' | 'super-admin'; actorEmail: string | null },
): Promise<ResetOutcome> {
  if (await recentlySent(target.email)) {
    return {
      ok: false,
      code: 'rate-limited',
      message: `A reset email was already sent to this account in the last ${RESET_COOLDOWN_MINUTES} minutes.`,
    }
  }

  const token = await setResetToken(target.email)
  // Addressed to the ACCOUNT, never to whoever triggered it. The token is
  // returned to this function and goes straight into the email — it is never
  // put in an API response or shown in the admin UI.
  const sent = await sendPasswordReset({
    to: target.email,
    firstName: target.firstName || undefined,
    restaurantName: target.restaurantName || undefined,
    resetUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
  })
  if (!sent.success) {
    return { ok: false, code: 'send-failed', message: 'The reset email could not be sent.' }
  }

  // logAdminAction is best-effort by design (a logging failure must never fail
  // the action it describes), so read back rather than assume.
  await logAdminAction({
    action: 'password_reset_sent',
    restaurantReference: target.restaurantReference || '',
    actorEmail: opts.actorEmail,
    detail: { targetEmail: target.email, targetRole: target.role, source: opts.source },
  })
  let audited = false
  try {
    audited = await recentlySent(target.email)
  } catch {
    audited = false
  }
  if (!audited) {
    console.error('[password-reset] audit row did not land for', target.email,
      '— the reset WAS sent; the trail and the cooldown are both missing for it.')
  }
  return { ok: true, audited }
}
