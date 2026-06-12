import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

// Finalizes restaurant onboarding by notifying the team (email + optional Slack)
// so a Disco Cater rep can follow up and take the merchant live. Notifications
// are best-effort — a failure must NOT block the merchant, so we always return
// { success: true }. Set SLACK_WEBHOOK_URL to enable the Slack message.
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
// Prefer a dedicated partner webhook; otherwise reuse the new-order webhook so
// signups still reach Slack (with a distinct message so they're not mistaken
// for orders).
const SLACK_WEBHOOK_URL = process.env.SLACK_PARTNER_WEBHOOK_URL || process.env.SLACK_NEW_ORDER_WEBHOOK_URL
const TEAM_EMAIL = 'concierge@discocater.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const restaurantName = String(body?.restaurantName || '').trim() || 'Unknown Restaurant'
    const email = String(body?.email || '').trim()
    const phone = String(body?.phone || '').trim()
    const zip = String(body?.zip || '').trim()
    const restaurantReference = String(body?.restaurantReference || '').trim()
    const menuFileName = String(body?.menuFileName || '').trim()
    const menuUrl = String(body?.menuUrl || '').trim()
    const joinedMarketplace = !!body?.joinedMarketplace
    const deliveryEnabled = !!body?.deliveryEnabled
    const stripeConnected = !!body?.stripeConnected

    const yn = (b: boolean) => (b ? 'Yes' : 'No')

    // Best-effort: record the uploaded menu reference on the cache row so the
    // super admin can see which restaurants have submitted a menu.
    if (restaurantReference && (menuUrl || menuFileName)) {
      try {
        await runMigrations()
        await sql`
          UPDATE disco_restaurant_cache
          SET menu_upload_url = ${menuUrl || menuFileName}
          WHERE restaurant_reference = ${restaurantReference}
        `
      } catch (err) {
        console.error('[complete] menu_upload_url save failed:', err instanceof Error ? err.message : err)
      }
    }

    const lines = [
      `Restaurant: ${restaurantName}`,
      `Contact email: ${email || 'Not provided'}`,
      `Phone: ${phone || 'Not provided'}`,
      `Zip: ${zip || 'Not provided'}`,
      restaurantReference ? `Restaurant ref: ${restaurantReference}` : '',
      '',
      `Joined marketplace (3P): ${yn(joinedMarketplace)}`,
      `Third-party delivery enabled: ${yn(deliveryEnabled)}`,
      `Stripe connected: ${yn(stripeConnected)}`,
      menuFileName ? `Menu file: ${menuFileName}` : '',
    ].filter(Boolean).join('\n')

    // Slack (optional). Distinct "New Partner Signup" format so it's never
    // confused with a new-order notification on the shared webhook.
    if (SLACK_WEBHOOK_URL) {
      try {
        await fetch(SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: [
              `🎉 *New Partner Signup* — ${restaurantName}`,
              `Email: ${email || 'Not provided'}`,
              `Phone: ${phone || 'Not provided'}`,
              `Zip: ${zip || 'Not provided'}`,
              `Marketplace: ${yn(joinedMarketplace)}`,
              `Delivery: ${yn(deliveryEnabled)}`,
              `Stripe: ${yn(stripeConnected)}`,
            ].join('\n'),
          }),
        })
      } catch (err) {
        console.error('[complete] Slack notify failed:', err instanceof Error ? err.message : err)
      }
    }

    // Email notification.
    if (MAILGUN_API_KEY && MAILGUN_DOMAIN) {
      const subject = `New Partner Onboarding Complete — ${restaurantName}`
      const text = `A restaurant has completed Disco Cater onboarding.\n\n${lines}\n\nFollow up to take the merchant live.\n\n— Disco Cater Onboarding`
      try {
        const mg = new FormData()
        mg.append('from', `Disco Cater Onboarding <onboarding@${MAILGUN_DOMAIN}>`)
        mg.append('to', TEAM_EMAIL)
        mg.append('subject', subject)
        mg.append('text', text)
        const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
          body: mg,
        })
        if (!res.ok) {
          const raw = await res.text().catch(() => '')
          console.error(`[complete] Mailgun ${res.status}: ${raw.slice(0, 300)}`)
        }
      } catch (err) {
        console.error('[complete] notification send failed:', err instanceof Error ? err.message : err)
      }
    } else {
      console.error('[complete] Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN).')
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
