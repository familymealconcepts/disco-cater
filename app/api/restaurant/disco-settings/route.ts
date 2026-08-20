import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { sql, runMigrations } from '../../../../lib/db'
import { isStripeReady } from '../../../../lib/stripe-readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// resolveDiscoScopeRef only resolves ctx.restaurantReference, which is always ''
// for ordinary FM-authenticated sessions (only Disco-native sessions carry it).
// order-settings/page.tsx (the Settings page ordinary FM restaurants land on)
// reads this route's GET for online_ordering_enabled, so an unguarded call here
// 400'd for every FM-backed restaurant on every Settings-page load (masked
// client-side by a silent default-to-true fallback, not a visible error).
async function currentRef(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>): Promise<string> {
  return ctx.authType === 'disco' ? await resolveDiscoScopeRef(ctx) : (await getRestaurantRef()) || ''
}

// Restaurant-level settings (Stage 9) for Disco-native restaurants — stored in
// disco_restaurant_overrides (SA location-scoped). Online ordering, delivery
// time-window granularity, tax rates, and notification recipients.
export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await currentRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  await runMigrations()
  const rows = (await sql`
    SELECT online_ordering_enabled, delivery_order_time_windows, tax_rates,
           notification_emails, notification_sms_numbers,
           order_reminder_emails_enabled, admin_order_reminder_emails_enabled, withhold_payouts,
           enable_menu_search, announcement, text_notifications_enabled
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
  `) as Record<string, unknown>[]
  // The restaurant's public slug (for the "Disco Cater URL" row) lives on the cache.
  const cacheRows = (await sql`SELECT slug FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { slug: string | null }[]
  return NextResponse.json({ restaurant_reference: ref, settings: rows[0] || {}, slug: cacheRows[0]?.slug || null })
}

const WINDOWS = new Set(['exact', '30_min', '1_hour'])

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  // Write target is the client-claimed restaurant_reference, verified against
  // the caller's permitted set — never the session's current selection (see
  // disco-profile's PUT for the full stale-intent rationale).
  const check = await requireWritableRestaurantRef(body?.restaurant_reference)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref

  // The settings page has one Save button for the whole form, so every save
  // resubmits onlineOrderingEnabled at whatever it currently is — not just
  // when the user actually touches that toggle. Standing rule:
  // online_ordering_enabled is never auto-corrected. Comparing against the
  // stored value (not just gating on the requested one) is what makes that
  // hold: if the request doesn't actually change the toggle, this never
  // re-runs the Stripe check at all, so an unrelated save (say, a
  // notification email) can't silently flip an already-live restaurant off
  // because the check happened to read wrong at that moment.
  const existingRows = (await sql`
    SELECT online_ordering_enabled, stripe_account_id, stripe_onboarding_complete
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
  `.catch(() => [])) as { online_ordering_enabled: boolean | null; stripe_account_id: string | null; stripe_onboarding_complete: boolean | null }[]
  const existing = existingRows[0]
  const requestedOnlineOrdering = body?.onlineOrderingEnabled === true

  let onlineOrdering: boolean
  if (existing && requestedOnlineOrdering === (existing.online_ordering_enabled !== false)) {
    // Unchanged from what's already stored (same COALESCE(...,true) convention
    // every reader uses) — leave it exactly as-is, no Stripe check at all.
    onlineOrdering = existing.online_ordering_enabled !== false
  } else if (requestedOnlineOrdering) {
    // A genuine attempt to turn it ON (either no row yet, or actually flipping
    // off→on) — RM2: requires a connected + onboarding-complete Stripe account
    // (mirrors the FM-backed settings gate), enforced server-side so a direct
    // API call can't enable it without a payout path.
    onlineOrdering = isStripeReady(existing)
  } else {
    // A genuine attempt to turn it OFF — always allowed, no gate needed.
    onlineOrdering = false
  }
  const window = WINDOWS.has(String(body?.deliveryOrderTimeWindows)) ? String(body.deliveryOrderTimeWindows) : 'exact'
  const taxRates = body?.taxRates != null ? JSON.stringify(body.taxRates) : null
  const emails = String(body?.notificationEmails || '').trim() || null
  const sms = String(body?.notificationSmsNumbers || '').trim() || null
  const orderReminders = body?.orderReminderEmailsEnabled === true
  const adminReminders = body?.adminOrderReminderEmailsEnabled === true
  const enableMenuSearch = body?.enableMenuSearch === true
  const announcement = String(body?.announcement || '').trim().slice(0, 500) || null
  const textNotifications = body?.textNotificationsEnabled === true

  await runMigrations()
  await sql`
    INSERT INTO disco_restaurant_overrides (
      restaurant_reference, online_ordering_enabled, delivery_order_time_windows, tax_rates,
      notification_emails, notification_sms_numbers, order_reminder_emails_enabled, admin_order_reminder_emails_enabled,
      enable_menu_search, announcement, text_notifications_enabled, updated_at)
    VALUES (${ref}, ${onlineOrdering}, ${window}, ${taxRates}::jsonb, ${emails}, ${sms}, ${orderReminders}, ${adminReminders},
      ${enableMenuSearch}, ${announcement}, ${textNotifications}, NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE SET
      online_ordering_enabled = EXCLUDED.online_ordering_enabled,
      delivery_order_time_windows = EXCLUDED.delivery_order_time_windows,
      tax_rates = COALESCE(EXCLUDED.tax_rates, disco_restaurant_overrides.tax_rates),
      notification_emails = EXCLUDED.notification_emails,
      notification_sms_numbers = EXCLUDED.notification_sms_numbers,
      order_reminder_emails_enabled = EXCLUDED.order_reminder_emails_enabled,
      admin_order_reminder_emails_enabled = EXCLUDED.admin_order_reminder_emails_enabled,
      enable_menu_search = EXCLUDED.enable_menu_search,
      announcement = EXCLUDED.announcement,
      text_notifications_enabled = EXCLUDED.text_notifications_enabled,
      updated_at = NOW()
  `
  return NextResponse.json({ ok: true })
}
