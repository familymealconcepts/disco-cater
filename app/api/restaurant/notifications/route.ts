import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET() {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/notifications`, { headers: authHeaders })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/notifications`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()

    // Mirror FM's notification settings into Neon so the daily reminder cron and
    // the server-side new-order dispatch (no restaurant session) can read them.
    // Mirrors the latest FM values written just above. Best-effort — never blocks.
    try {
      const ctx = await getRestaurantAuthContext()
      const ref = ctx?.restaurantReference || (await getRestaurantRef()) || ''
      if (ref) {
        const emails = Array.isArray(body?.email)
          ? Array.from(new Set((body.email as unknown[]).map(e => String(e).trim()).filter(Boolean)))
          : []
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
