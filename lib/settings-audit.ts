// Shared plumbing for auditing restaurant-affecting SETTINGS writes into
// disco_admin_audit (the same table lib/admin-audit.ts and lib/master-login.ts
// use — one trail, not a parallel one).
//
// Every settings audit row follows the same contract, so a dispute can be
// answered by one query rather than by reading nine routes:
//
//   action                one per settings surface, snake_case
//   restaurant_reference  the ref actually WRITTEN (post-remap, post-scope-check)
//   actor_email           the human, resolved per auth system (see below)
//   detail                { authType, before, after, ...extra }
//
// `before`/`after` carry ONLY the fields that route writes. Not the whole row:
// a wide snapshot makes it impossible to tell at a glance what the save
// actually changed, which is the one question the row exists to answer.
// `before: null` means "no row existed yet" — distinct from an all-empty
// before, which means the row existed and those fields were unset.
//
// Nothing here throws. logAdminAction already swallows its own errors, and the
// snapshot readers below catch and return null: a degraded audit row is always
// better than a settings write that fails because its logging did.
import { sql } from './db'
import { logAdminAction, type AdminAuditAction } from './admin-audit'
import { decodeJwtPayload } from './jwt'
import type { RestaurantAuthContext } from './restaurant-auth-context'

// ── Actor resolution ────────────────────────────────────────────────────────

// Who made a RESTAURANT-portal write. A Disco-native session carries the
// account email on the context directly; an FM-token session's ctx.email is
// ALWAYS '' (that path resolves identity per-request from the token and never
// onto the context — the same root cause as the blank ctx.restaurantReference),
// so read the FM JWT's `sub` claim, which FM sets to the user's email.
//
// Returns null rather than a guess when neither is available: a wrong actor in
// an audit trail is worse than a missing one.
export function restaurantActorEmail(ctx: RestaurantAuthContext): string | null {
  if (ctx.email) return ctx.email
  if (ctx.fmToken) {
    const sub = decodeJwtPayload(ctx.fmToken)?.sub
    if (typeof sub === 'string' && sub.trim()) return sub.trim()
  }
  return null
}

// ── Snapshots ───────────────────────────────────────────────────────────────
// One SELECT per table covering the union of columns any audited settings route
// writes. Callers `pick()` the subset they actually touch. Static SQL (no
// dynamic column lists) at the cost of reading a few extra columns.

export interface OverridesRow {
  notification_emails: string | null
  notification_sms_numbers: string | null
  order_reminder_emails_enabled: boolean | null
  admin_order_reminder_emails_enabled: boolean | null
  text_notifications_enabled: boolean | null
  online_ordering_enabled: boolean | null
  delivery_order_time_windows: string | null
  tax_rates: unknown
  enable_menu_search: boolean | null
  announcement: string | null
  visible: boolean | null
  is_premium: boolean | null
  order_url: string | null
  money_flow: string | null
  stripe_account_id: string | null
  withhold_payouts: boolean | null
}

export async function overridesSnapshot(ref: string): Promise<OverridesRow | null> {
  try {
    const rows = (await sql`
      SELECT notification_emails, notification_sms_numbers, order_reminder_emails_enabled,
             admin_order_reminder_emails_enabled, text_notifications_enabled,
             online_ordering_enabled, delivery_order_time_windows, tax_rates,
             enable_menu_search, announcement, visible, is_premium, order_url,
             money_flow, stripe_account_id, withhold_payouts
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
    `) as OverridesRow[]
    return rows[0] ?? null
  } catch (e) {
    console.error('[settings-audit] overrides snapshot failed:', e instanceof Error ? e.message : e)
    return null
  }
}

export interface CacheRow {
  name: string | null
  slug: string | null
  cuisine: string | null
  description: string | null
  location: string | null
  lat: string | null
  lng: string | null
  image_url: string | null
  is_live: boolean | null
}

export async function cacheSnapshot(ref: string): Promise<CacheRow | null> {
  try {
    const rows = (await sql`
      SELECT name, slug, cuisine, description, location, lat, lng, image_url, is_live
      FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as CacheRow[]
    return rows[0] ?? null
  } catch (e) {
    console.error('[settings-audit] cache snapshot failed:', e instanceof Error ? e.message : e)
    return null
  }
}

// disco_restaurant_accounts.joined_marketplace — the third table the
// marketplace toggles keep in step, and the one most likely to drift unnoticed.
export async function accountMarketplaceSnapshot(ref: string): Promise<{ joined_marketplace: boolean | null } | null> {
  try {
    const rows = (await sql`
      SELECT joined_marketplace FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${ref} ORDER BY id LIMIT 1
    `) as { joined_marketplace: boolean | null }[]
    return rows[0] ?? null
  } catch (e) {
    console.error('[settings-audit] account snapshot failed:', e instanceof Error ? e.message : e)
    return null
  }
}

// Narrow a snapshot to the fields a route writes. Returns null for a null
// snapshot so "no row yet" survives into the audit detail rather than becoming
// an object full of undefineds.
export function pick<T extends object, K extends keyof T>(row: T | null, keys: readonly K[]): Pick<T, K> | null {
  if (!row) return null
  const out = {} as Pick<T, K>
  for (const k of keys) out[k] = row[k]
  return out
}

// ── The write ───────────────────────────────────────────────────────────────

export async function logSettingsChange(params: {
  action: AdminAuditAction
  restaurantReference: string
  actorEmail: string | null
  /** 'disco' | 'fm' for restaurant-portal routes; 'admin' for the super-admin portal. */
  authType: 'disco' | 'fm' | 'admin'
  before: unknown
  after: unknown
  /** Route-specific context worth keeping — e.g. an FM proxy's outcome, a remapped ref. */
  extra?: Record<string, unknown>
}): Promise<void> {
  await logAdminAction({
    action: params.action,
    restaurantReference: params.restaurantReference,
    actorEmail: params.actorEmail,
    detail: {
      authType: params.authType,
      before: params.before,
      after: params.after,
      ...(params.extra || {}),
    },
  })
}
