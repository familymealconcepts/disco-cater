import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// The restaurant Settings "Notifications" section (multi-email + multi-phone
// recipient lists + reminder toggle). Two account types, never lose either:
//   • FM-token restaurants  → proxy FM /api/notifications exactly as before.
//   • Disco-native (no FM token) → serve the SAME shape from Neon (the FM call
//     would 401, which hid the whole section). Email list lives in
//     disco_restaurant_overrides.notification_emails; phone list in
//     disco_restaurant_sms_recipients (fallback: legacy sms_phone).

interface NotificationsShape {
  email: string[]
  phoneNumber: string[]
  emailNotificationType: 'ALL' | 'ORDERS_ONLY' | 'OFF'
  phoneNotificationType: 'ALL' | 'OFF'
  autoPrint: boolean
  orderReminderEmailsEnabled: boolean
}

const cleanList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set((v as unknown[]).map(x => String(x).trim()).filter(Boolean))) : []

// Build the FM-shaped notifications object for a Disco-native restaurant from Neon.
async function discoNativeNotifications(ref: string): Promise<NotificationsShape> {
  await runMigrations()
  const ov = (await sql`
    SELECT notification_emails, order_reminder_emails_enabled
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { notification_emails: string | null; order_reminder_emails_enabled: boolean | null }[]
  const email = String(ov[0]?.notification_emails || '').split(',').map(s => s.trim()).filter(Boolean)
  const reminderOn = ov[0]?.order_reminder_emails_enabled === true

  // Phone recipients from the new multi-phone table; fall back to the legacy
  // single sms_phone so nothing already configured is lost.
  const recips = (await sql`
    SELECT phone FROM disco_restaurant_sms_recipients WHERE restaurant_reference = ${ref} ORDER BY id
  `) as { phone: string }[]
  let phoneNumber = recips.map(r => r.phone).filter(Boolean)
  if (phoneNumber.length === 0) {
    const acct = (await sql`
      SELECT sms_phone FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${ref} AND sms_phone IS NOT NULL AND sms_phone <> ''
      ORDER BY id LIMIT 1
    `) as { sms_phone: string }[]
    if (acct[0]?.sms_phone) phoneNumber = [acct[0].sms_phone]
  }

  return {
    email,
    phoneNumber,
    emailNotificationType: email.length ? 'ALL' : 'OFF',
    phoneNotificationType: phoneNumber.length ? 'ALL' : 'OFF',
    autoPrint: false,
    orderReminderEmailsEnabled: reminderOn,
  }
}

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── FM-token path — unchanged ───────────────────────────────────────────────
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

      // Mirror FM's settings into Neon so the reminder cron + new-order dispatch
      // (no restaurant session) can read them. Best-effort — never blocks.
      try {
        const ref = ctx.restaurantReference || (await getRestaurantRef()) || ''
        if (ref) {
          const emails = cleanList(body?.email)
          const reminderOn = body?.orderReminderEmailsEnabled === true
          await runMigrations()
          await sql`
            INSERT INTO disco_restaurant_overrides (restaurant_reference, order_reminder_emails_enabled, notification_emails, updated_at)
            VALUES (${ref}, ${reminderOn}, ${emails.join(',') || null}, NOW())
            ON CONFLICT (restaurant_reference) DO UPDATE
              SET order_reminder_emails_enabled = ${reminderOn},
                  notification_emails = ${emails.join(',') || null},
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
    const emails = cleanList(body?.email)
    const phones = cleanList(body?.phoneNumber)
    const reminderOn = body?.orderReminderEmailsEnabled === true

    // Email list + reminder toggle → disco_restaurant_overrides.
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, order_reminder_emails_enabled, notification_emails, updated_at)
      VALUES (${ref}, ${reminderOn}, ${emails.join(',') || null}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET order_reminder_emails_enabled = ${reminderOn},
            notification_emails = ${emails.join(',') || null},
            updated_at = NOW()
    `

    // Phone list → disco_restaurant_sms_recipients (replace the set: delete all,
    // re-insert current). A small per-restaurant list, so this is the simplest
    // correct "delete removed + insert new".
    await sql`DELETE FROM disco_restaurant_sms_recipients WHERE restaurant_reference = ${ref}`
    for (const phone of phones) {
      await sql`
        INSERT INTO disco_restaurant_sms_recipients (restaurant_reference, phone)
        VALUES (${ref}, ${phone})
        ON CONFLICT (restaurant_reference, phone) DO NOTHING
      `
    }

    // Keep legacy sms_enabled/sms_phone in sync for back-compat (first number).
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
