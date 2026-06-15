import { NextRequest, NextResponse } from 'next/server'

// No shared email util exists in the repo yet, so this calls Mailgun's HTTP API
// directly (Basic auth: api:{MAILGUN_API_KEY}). Set MAILGUN_API_KEY + MAILGUN_DOMAIN
// in the environment.
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
const TEAM_EMAIL = 'concierge@discocater.com'

export async function POST(req: NextRequest) {
  let menuUrl = ''
  let restaurantName = ''
  let email = ''
  let restaurantReference = ''
  let menuFile: File | null = null

  const ct = req.headers.get('content-type') || ''
  try {
    if (ct.startsWith('multipart/form-data')) {
      const fd = await req.formData()
      menuUrl = String(fd.get('menuUrl') || '').trim()
      restaurantName = String(fd.get('restaurantName') || '').trim()
      email = String(fd.get('email') || '').trim()
      restaurantReference = String(fd.get('restaurantReference') || '').trim()
      const f = fd.get('menuFile')
      if (f && f instanceof Blob && (f as File).size > 0) menuFile = f as File
    } else {
      const body = await req.json()
      menuUrl = String(body?.menuUrl || '').trim()
      restaurantName = String(body?.restaurantName || '').trim()
      email = String(body?.email || '').trim()
      restaurantReference = String(body?.restaurantReference || '').trim()
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  // Nothing submitted → the merchant skipped the menu step. Succeed silently.
  if (!menuUrl && !menuFile) {
    return NextResponse.json({ success: true })
  }

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.error('[menu-upload] Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN).')
    return NextResponse.json({ error: 'Email is not configured.' }, { status: 500 })
  }

  const safeName = restaurantName || 'Unknown Restaurant'
  const subject = `New Restaurant Menu Upload — ${safeName}`
  const text = `A new restaurant has completed onboarding and submitted their menu for import.

Restaurant: ${safeName}
Email: ${email || 'Not provided'}
Restaurant ref: ${restaurantReference || 'Not provided'}

Menu URL: ${menuUrl || 'Not provided'}
Menu File: ${menuFile?.name || 'Not provided'}

Please import this menu using the Menu Import tool in the Disco Cater super admin:
https://www.discocater.com/admin/manage-restaurants/menu-import

— Disco Cater Onboarding`

  try {
    const mg = new FormData()
    // Use the verified envelope sender (same as lib/email/send.ts) rather than
    // deriving it from MAILGUN_DOMAIN, which Mailgun can reject as an
    // unauthorized sender. sendEmail() can't be used here — it has no attachment
    // support and we need to attach the menu PDF.
    mg.append('from', 'Disco Cater <orders@discocater.com>')
    mg.append('to', TEAM_EMAIL)
    mg.append('subject', subject)
    mg.append('text', text)
    if (menuFile) mg.append('attachment', menuFile, menuFile.name || 'menu')

    const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
      body: mg,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[menu-upload] Mailgun ${res.status}: ${raw.slice(0, 300)}`)
      return NextResponse.json({ error: 'Could not send the menu email.' }, { status: 502 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[menu-upload] send failed:', err)
    return NextResponse.json({ error: 'Could not send the menu email.' }, { status: 500 })
  }
}
