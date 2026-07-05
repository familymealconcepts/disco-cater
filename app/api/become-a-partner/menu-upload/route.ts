import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { sql } from '../../../../lib/db'

// Menu intake for the become-a-partner onboarding (Step 7).
//
// SCOPE (deliberately reduced — no AI): we do NOT parse the menu or create any
// menu items automatically. We simply STORE the submitted menu where the Disco
// / super-admin team can pick it up and set it up by hand:
//   · source 'pdf' → upload the PDF to Vercel Blob (durable, super-admin
//     accessible) and email the Disco team a link + the attachment.
//   · source 'url' → email the Disco team the menu URL.
//   · source 'skip' → note that the partner skipped, so the team can follow up.
// Always returns { success } — intake is best-effort and never blocks the
// partner from finishing onboarding. (AI menu building is parked for later; see
// the become-a-partner backlog.)
//
// This route is PUBLIC (no admin cookie) — it only stores/forwards, no FM calls.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
const TEAM_EMAIL = 'concierge@discocater.com'
const ADMIN_MENU_TOOL = 'https://www.discocater.com/admin/manage-restaurants/menu-import'

const MAX_PDF_BYTES = 10 * 1024 * 1024 // 10MB

// ── Mailgun ───────────────────────────────────────────────────────────────────

// Email the Disco team. `attachment` (a PDF buffer) is optional. Returns false
// on any send failure — callers treat the email as best-effort.
async function notifyTeam(subject: string, text: string, attachment?: { buffer: Buffer; filename: string }): Promise<boolean> {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.error('[menu-upload] Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN).')
    return false
  }
  try {
    const mg = new FormData()
    // Verified envelope sender (same as lib/email/send.ts) — deriving it from
    // MAILGUN_DOMAIN can be rejected as an unauthorized sender.
    mg.append('from', 'Disco Cater <orders@discocater.com>')
    mg.append('to', TEAM_EMAIL)
    mg.append('subject', subject)
    mg.append('text', text)
    if (attachment) mg.append('attachment', new Blob([new Uint8Array(attachment.buffer)], { type: 'application/pdf' }), attachment.filename)
    const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
      body: mg,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[menu-upload] Mailgun ${res.status}: ${raw.slice(0, 300)}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[menu-upload] Mailgun send failed:', err)
    return false
  }
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const source = String(body?.source || '').trim() as 'pdf' | 'url' | 'skip'
  const restaurantName = String(body?.restaurantName || '').trim()
  const restaurantEmail = String(body?.restaurantEmail || '').trim()
  const restaurantReference = String(body?.restaurantReference || '').trim()
  const url = String(body?.url || '').trim()
  const fileBase64 = typeof body?.fileBase64 === 'string' ? body.fileBase64 : ''
  const safeName = restaurantName || 'Unknown Restaurant'

  // ── Skip: note it for the team, nothing to store. ──
  if (source === 'skip') {
    await notifyTeam(
      `Menu Upload — ${safeName} (skipped)`,
      `Restaurant ${safeName} skipped menu upload during onboarding.\n\nEmail: ${restaurantEmail || 'Not provided'}\nRestaurant ref: ${restaurantReference || 'Not yet created'}`,
    )
    return NextResponse.json({ success: true })
  }

  if (source !== 'pdf' && source !== 'url') {
    return NextResponse.json({ error: 'Invalid source.' }, { status: 400 })
  }

  // ── URL: just forward the link to the team. ──
  if (source === 'url') {
    if (!url) return NextResponse.json({ error: 'A menu URL is required.' }, { status: 400 })
    await notifyTeam(
      `Menu Upload — ${safeName}`,
      `A restaurant submitted a menu link during onboarding. Please set up their catering menu.\n\nRestaurant: ${safeName}\nEmail: ${restaurantEmail || 'Not provided'}\nRestaurant ref: ${restaurantReference || 'Not yet created'}\nMenu URL: ${url}\n\nMenu Import tool: ${ADMIN_MENU_TOOL}`,
    )
    return NextResponse.json({ success: true })
  }

  // ── PDF: store to Blob (super-admin accessible) + forward to the team. ──
  if (!fileBase64) return NextResponse.json({ error: 'A PDF file is required.' }, { status: 400 })

  let pdfBuffer: Buffer
  try { pdfBuffer = Buffer.from(fileBase64, 'base64') } catch { pdfBuffer = Buffer.alloc(0) }
  if (!pdfBuffer.length) return NextResponse.json({ error: 'Could not read the uploaded PDF.' }, { status: 400 })
  if (pdfBuffer.length > MAX_PDF_BYTES) return NextResponse.json({ error: 'PDF is too large (max 10MB).' }, { status: 400 })

  // Store to Vercel Blob so the super-admin/Disco team always has a durable copy,
  // independent of email delivery. Best-effort — a Blob failure still falls back
  // to the email attachment below.
  let blobUrl = ''
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const slug = (safeName || 'menu').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
      const path = `partner-menus/${slug}-${restaurantReference || 'noref'}.pdf`
      const blob = await put(path, pdfBuffer, { access: 'public', contentType: 'application/pdf', addRandomSuffix: true })
      blobUrl = blob.url
      console.log(`[menu-upload] stored menu PDF for ${safeName} at ${blobUrl}`)
    } catch (err) {
      console.error('[menu-upload] Blob store failed (falling back to email attachment):', err instanceof Error ? err.message : err)
    }
  } else {
    console.warn('[menu-upload] BLOB_READ_WRITE_TOKEN not set — menu PDF forwarded by email only.')
  }

  // Persist the durable Blob URL as the restaurant's menu_upload_url so super-admin's
  // "View Menu" opens the actual PDF. Previously only the local FILENAME was stored
  // (via /complete), which resolved to nothing. Best-effort; the row exists by now
  // (seeded at create-restaurant). complete/route.ts no longer overwrites a URL.
  if (blobUrl && restaurantReference) {
    try {
      await sql`UPDATE disco_restaurant_cache SET menu_upload_url = ${blobUrl} WHERE restaurant_reference = ${restaurantReference}`
    } catch (err) {
      console.error('[menu-upload] menu_upload_url persist failed:', err instanceof Error ? err.message : err)
    }
  }

  const emailed = await notifyTeam(
    `Menu Upload — ${safeName}`,
    `A restaurant uploaded their menu PDF during onboarding. Please set up their catering menu.\n\nRestaurant: ${safeName}\nEmail: ${restaurantEmail || 'Not provided'}\nRestaurant ref: ${restaurantReference || 'Not yet created'}\nStored menu PDF: ${blobUrl || '(storage unavailable — see attachment)'}\n\nMenu Import tool: ${ADMIN_MENU_TOOL}`,
    { buffer: pdfBuffer, filename: 'menu.pdf' },
  )

  // As long as we stored OR emailed the menu, the team can pick it up.
  if (!blobUrl && !emailed) {
    return NextResponse.json({ error: 'Could not store your menu. Please try again or add items from your dashboard.' }, { status: 502 })
  }

  return NextResponse.json({ success: true, stored: !!blobUrl })
}
