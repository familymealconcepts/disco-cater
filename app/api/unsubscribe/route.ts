import { NextRequest, NextResponse } from 'next/server'
import { runMigrations } from '../../../lib/db'
import { optOutOfMarketing, verifyUnsubscribeToken } from '../../../lib/marketing-opt-out'

// Public, unauthenticated — reached by clicking the unsubscribe link in a
// marketing/announcement email. Only ever marks marketing_email_opt_outs;
// never touches Mailgun's suppression list (see lib/marketing-opt-out.ts for why)
// and has no effect on transactional email (order confirmations, reminders,
// receipts), which don't consult this table.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email') || ''
  const token = req.nextUrl.searchParams.get('token') || ''

  const page = (body: string) => new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Disco Cater</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1A1028;text-align:center}
    h1{font-size:20px}p{color:#555;line-height:1.5}</style></head>
    <body>${body}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return page('<h1>Invalid or expired unsubscribe link</h1><p>Please contact concierge@discocater.com if you need help.</p>')
  }

  try {
    await runMigrations()
    await optOutOfMarketing(email, 'link-click')
  } catch (e) {
    console.error('[unsubscribe] failed to record opt-out for', email, e instanceof Error ? e.message : e)
    return page('<h1>Something went wrong</h1><p>Please contact concierge@discocater.com and we\'ll remove you manually.</p>')
  }

  return page(`<h1>You're unsubscribed</h1><p>${email} won't receive marketing or announcement emails from Disco Cater going forward. You'll still receive emails related to any orders you place.</p>`)
}
