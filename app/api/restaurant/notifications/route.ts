import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'
import { sanitizePhone } from '../../../../lib/utils/phone'
import { restaurantActorEmail, overridesSnapshot, logSettingsChange } from '../../../../lib/settings-audit'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// The restaurant Settings "Notifications" section (multi-email + multi-phone
// recipient lists + reminder toggle). Two account types, never lose either:
//   • FM-token restaurants  → proxy FM /api/notifications exactly as before (FM
//     stays authoritative).
//   • Disco-native (no FM token) → serve the SAME shape from Neon (the FM call
//     would 401, which hid the whole section). Neon is authoritative:
//       email[]       ← disco_restaurant_overrides.notification_emails (CSV)
//       phoneNumber[] ← disco_restaurant_overrides.notification_sms_numbers (CSV)
//       reminder      ← disco_restaurant_overrides.order_reminder_emails_enabled

interface NotificationsShape {
  email: string[]
  phoneNumber: string[]
  emailNotificationType: 'ALL' | 'ORDERS_ONLY' | 'OFF'
  phoneNotificationType: 'ALL' | 'OFF'
  autoPrint: boolean
  orderReminderEmailsEnabled: boolean
  adminOrderReminderEmailsEnabled: boolean
  discoNative?: boolean
}

const cleanEmails = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set((v as unknown[]).map(x => String(x).trim()).filter(Boolean))) : []

const cleanPhones = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set((v as unknown[]).map(x => sanitizePhone(String(x))).filter(Boolean))) : []

const splitCsv = (v: string | null | undefined): string[] =>
  String(v || '').split(',').map(s => s.trim()).filter(Boolean)

// ── Audit attribution ───────────────────────────────────────────────────────
// Actor resolution and the audit write itself live in lib/settings-audit.ts —
// every audited settings route shares them, so the FM-token identity quirk
// (ctx.email is always '') is handled in exactly one place.

interface NotificationSnapshot {
  email: string[]
  phoneNumber: string[]
  orderReminderEmailsEnabled: boolean | null
  adminOrderReminderEmailsEnabled: boolean | null
  textNotificationsEnabled: boolean | null
}

// Pre-save values for the audit detail's `before`, in the same shape this route
// reports in `after`. Read from disco_restaurant_overrides in BOTH branches — on
// the FM-token path that row is FM's mirror, so `before` there is the
// previously-mirrored FM state, which is exactly the value a later "FM says
// otherwise" dispute is about. null means "no overrides row yet" (a first-ever
// save), distinct from an all-empty snapshot, which means the row existed and
// was blank.
async function notificationSnapshot(ref: string): Promise<NotificationSnapshot | null> {
  const row = await overridesSnapshot(ref)
  if (!row) return null
  return {
    email: splitCsv(row.notification_emails),
    phoneNumber: splitCsv(row.notification_sms_numbers),
    orderReminderEmailsEnabled: row.order_reminder_emails_enabled,
    adminOrderReminderEmailsEnabled: row.admin_order_reminder_emails_enabled,
    textNotificationsEnabled: row.text_notifications_enabled,
  }
}

// Build the FM-shaped notifications object for a Disco-native restaurant from Neon.
// `emailNotificationType`/`phoneNotificationType` are DERIVED from whether the
// respective recipient list is non-empty rather than stored separately: there is
// no Neon column for FM's tri-state, the new-order dispatch sends to the lists
// regardless of these flags, and FM's 'ORDERS_ONLY' middle state has no
// Disco-native meaning — so the flag is just a display reflection of "is anyone
// configured to receive this?". `autoPrint` defaults off (no Disco-native feature).
async function discoNativeNotifications(ref: string): Promise<NotificationsShape> {
  await runMigrations()
  const ov = (await sql`
    SELECT notification_emails, notification_sms_numbers, order_reminder_emails_enabled, admin_order_reminder_emails_enabled, text_notifications_enabled
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { notification_emails: string | null; notification_sms_numbers: string | null; order_reminder_emails_enabled: boolean | null; admin_order_reminder_emails_enabled: boolean | null; text_notifications_enabled: boolean | null }[]

  // Account row supplies the back-compat fallbacks + first-view seed values.
  const acct = (await sql`
    SELECT email, sms_phone FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} ORDER BY id LIMIT 1
  `) as { email: string | null; sms_phone: string | null }[]
  const acctEmail = acct[0]?.email || ''
  const acctSmsPhone = acct[0]?.sms_phone || ''

  // Email list — seed (display-only, NOT written) with the account email when the
  // restaurant has never saved a list, so it isn't empty on first view.
  let email = splitCsv(ov[0]?.notification_emails)
  if (email.length === 0 && acctEmail) email = [acctEmail]

  // Phone list — fall back to the legacy single sms_phone so existing single-number
  // configs aren't lost (also display-only until the user saves).
  let phoneNumber = splitCsv(ov[0]?.notification_sms_numbers)
  if (phoneNumber.length === 0 && acctSmsPhone) phoneNumber = [acctSmsPhone]

  // phoneNotificationType now reflects the REAL stored toggle (the column both PUT
  // branches actually persist as of this fix) rather than re-deriving from list
  // non-emptiness — those can legitimately disagree (numbers saved, toggle off).
  // null (never saved under this route at all — legacy data) falls back to the old
  // list-based heuristic so a restaurant with a carried-over legacy sms_phone still
  // shows something sensible before its first save under the fixed code.
  const phoneNotificationType: 'ALL' | 'OFF' =
    ov[0]?.text_notifications_enabled != null
      ? (ov[0].text_notifications_enabled ? 'ALL' : 'OFF')
      : (phoneNumber.length ? 'ALL' : 'OFF')

  return {
    email,
    phoneNumber,
    emailNotificationType: email.length ? 'ALL' : 'OFF',
    phoneNotificationType,
    autoPrint: false,
    orderReminderEmailsEnabled: ov[0]?.order_reminder_emails_enabled === true,
    // FM entity default is TRUE; NULL (never mirrored) reflects that default.
    adminOrderReminderEmailsEnabled: ov[0]?.admin_order_reminder_emails_enabled !== false,
    discoNative: true,
  }
}

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── FM-token path — unchanged FM proxy ──────────────────────────────────────
  if (ctx.fmToken) {
    try {
      const res = await fetch(`${FM}/api/notifications`, { headers: { Authorization: ctx.fmToken } })
      if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
      return NextResponse.json(await res.json())
    } catch {
      return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 })
    }
  }

  // ── Disco-native path — serve from Neon ─────────────────────────────────────
  const ref = ctx.restaurantReference || (await getRestaurantRef()) || ''
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  try {
    return NextResponse.json(await discoNativeNotifications(ref))
  } catch (e) {
    console.error('[restaurant/notifications] disco GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  // ── FM-token path — proxy FM, then mirror to Neon (unchanged behavior) ──────
  if (ctx.fmToken) {
    try {
      const res = await fetch(`${FM}/api/notifications`, {
        method: 'PUT',
        headers: { Authorization: ctx.fmToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
      const text = await res.text()

      // Values FM has now accepted. Hoisted out of the mirror block below so the
      // audit row can be written independently of whether the mirror succeeds.
      const ref = ctx.restaurantReference || (await getRestaurantRef()) || ''
      const emails = cleanEmails(body?.email)
      const phones = cleanPhones(body?.phoneNumber)
      const reminderOn = body?.orderReminderEmailsEnabled === true
      const textNotificationsEnabled = body?.phoneNotificationType === 'ALL'
      // FM's separate restaurant-reminder toggle — prefer the value FM returns,
      // fall back to what the UI sent. null → don't overwrite (COALESCE keeps
      // the existing/entity-default value).
      let fmObj: Record<string, unknown> = {}
      try { fmObj = text ? JSON.parse(text) : {} } catch { /* non-JSON body */ }
      const adminReminderOn: boolean | null =
        typeof fmObj.adminOrderReminderEmailsEnabled === 'boolean' ? fmObj.adminOrderReminderEmailsEnabled
        : typeof body?.adminOrderReminderEmailsEnabled === 'boolean' ? (body.adminOrderReminderEmailsEnabled as boolean)
        : null

      // Attribution row, BEFORE the mirror write — FM has already accepted the
      // change by this point, so a mirror failure must not also lose the record
      // of who made it. Snapshot first (the mirror is what overwrites it).
      // Self-contained try: FM's PUT has already succeeded, so nothing in here —
      // including runMigrations — may turn this request into a 500.
      try {
        if (ref) {
          await runMigrations()
          const before = await notificationSnapshot(ref)
          await logSettingsChange({
            action: 'notifications_update',
            restaurantReference: ref,
            actorEmail: restaurantActorEmail(ctx),
            authType: ctx.authType,
            before,
            after: {
              email: emails,
              phoneNumber: phones,
              orderReminderEmailsEnabled: reminderOn,
              adminOrderReminderEmailsEnabled: adminReminderOn,
              textNotificationsEnabled,
            },
          })
        }
      } catch (e) {
        console.error('[restaurant/notifications] audit row failed:', e instanceof Error ? e.message : e)
      }

      // Mirror FM's settings into Neon so the reminder cron + new-order dispatch
      // (no restaurant session) can read them. Best-effort — never blocks.
      //
      // Previously mirrored ONLY notification_emails + the two reminder booleans —
      // notification_sms_numbers and text_notifications_enabled were silently
      // dropped every save, for every restaurant using this FM-token path. Invisible
      // for a long time because dispatchOrderConfirmations never even runs for
      // FM-backed orders (FM notifies those itself) — it only became consequential
      // the moment a restaurant converts to native while still authenticating via
      // an FM token (no real Disco login yet). Confirmed live on both Glen Rock and
      // Pelican Delicatessen: emails mirrored, SMS + toggle silently missing.
      try {
        if (ref) {
          await runMigrations()
          await sql`
            INSERT INTO disco_restaurant_overrides (restaurant_reference, order_reminder_emails_enabled, admin_order_reminder_emails_enabled, notification_emails, notification_sms_numbers, text_notifications_enabled, updated_at)
            VALUES (${ref}, ${reminderOn}, ${adminReminderOn}, ${emails.join(',') || null}, ${phones.join(',') || null}, ${textNotificationsEnabled}, NOW())
            ON CONFLICT (restaurant_reference) DO UPDATE
              SET order_reminder_emails_enabled = ${reminderOn},
                  admin_order_reminder_emails_enabled = COALESCE(${adminReminderOn}::boolean, disco_restaurant_overrides.admin_order_reminder_emails_enabled),
                  notification_emails = ${emails.join(',') || null},
                  notification_sms_numbers = ${phones.join(',') || null},
                  text_notifications_enabled = ${textNotificationsEnabled},
                  updated_at = NOW()
          `
        }
      } catch (e) {
        console.error('[restaurant/notifications] Neon mirror failed:', e instanceof Error ? e.message : e)
      }

      return NextResponse.json(text ? JSON.parse(text) : { ok: true })
    } catch {
      return NextResponse.json({ error: 'Unable to update' }, { status: 500 })
    }
  }

  // ── Disco-native path — persist entirely to Neon ────────────────────────────
  const ref = ctx.restaurantReference || (await getRestaurantRef()) || ''
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  try {
    await runMigrations()
    const emails = cleanEmails(body?.email)
    const phones = cleanPhones(body?.phoneNumber)
    const reminderOn = body?.orderReminderEmailsEnabled === true
    // Same field this route's FM-token branch derives it from — the UI sends
    // phoneNotificationType ('ALL' | 'OFF'), not a plain boolean. Previously never
    // written at all in this branch either, so dispatchOrderConfirmations' SMS gate
    // (which hard-requires this column to be true) could never be satisfied via
    // this route regardless of how many phone numbers were saved.
    const textNotificationsEnabled = body?.phoneNotificationType === 'ALL'
    // The Disco-native settings UI has no admin-reminder toggle yet — honor it if
    // ever sent, otherwise preserve the existing value (COALESCE below).
    const adminReminderOn: boolean | null =
      typeof body?.adminOrderReminderEmailsEnabled === 'boolean' ? (body.adminOrderReminderEmailsEnabled as boolean) : null

    // Attribution row. Snapshot BEFORE the write below, logged before it too:
    // this is the only record of who changed these settings, and losing it to a
    // failed write is the exact case it exists for. Neon is authoritative on
    // this path, so `before`/`after` here are the real old and new values.
    const before = await notificationSnapshot(ref)
    await logSettingsChange({
      action: 'notifications_update',
      restaurantReference: ref,
      actorEmail: restaurantActorEmail(ctx),
      authType: ctx.authType,
      before,
      after: {
        email: emails,
        phoneNumber: phones,
        orderReminderEmailsEnabled: reminderOn,
        adminOrderReminderEmailsEnabled: adminReminderOn,
        textNotificationsEnabled,
      },
    })

    // Email list + phone list + reminder toggles → disco_restaurant_overrides (CSV).
    await sql`
      INSERT INTO disco_restaurant_overrides
        (restaurant_reference, order_reminder_emails_enabled, admin_order_reminder_emails_enabled, notification_emails, notification_sms_numbers, text_notifications_enabled, updated_at)
      VALUES (${ref}, ${reminderOn}, ${adminReminderOn}, ${emails.join(',') || null}, ${phones.join(',') || null}, ${textNotificationsEnabled}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET order_reminder_emails_enabled = ${reminderOn},
            admin_order_reminder_emails_enabled = COALESCE(${adminReminderOn}::boolean, disco_restaurant_overrides.admin_order_reminder_emails_enabled),
            notification_emails = ${emails.join(',') || null},
            notification_sms_numbers = ${phones.join(',') || null},
            text_notifications_enabled = ${textNotificationsEnabled},
            updated_at = NOW()
    `

    // Keep legacy sms_enabled/sms_phone in sync for any code still reading them.
    await sql`
      UPDATE disco_restaurant_accounts
      SET sms_enabled = ${phones.length > 0}, sms_phone = ${phones[0] || null}, updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `

    return NextResponse.json(await discoNativeNotifications(ref))
  } catch (e) {
    console.error('[restaurant/notifications] disco PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update' }, { status: 500 })
  }
}
