// Single Mailgun sender for Disco Cater transactional email.
//
// Mirrors the hand-rolled Mailgun HTTP pattern already used in
// app/api/cron/recurring-orders/route.ts and app/api/become-a-partner — no SDK.
// This is additive; those existing senders are left untouched.
//
// Contract: NEVER throws. Always resolves to a result object so callers can
// fire-and-forget without risking an unhandled rejection.

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  /** Defaults to "Disco Cater <orders@discocater.com>". */
  from?: string
  replyTo?: string
  bcc?: string
  /** Optional file attachments (e.g. a scheduled-report CSV or the order PDF).
   *  content may be a string (text/CSV) or binary bytes (PDF). */
  attachments?: { filename: string; content: string | Uint8Array; contentType?: string }[]
}

export interface SendResult {
  success: boolean
  error?: string
}

const DEFAULT_FROM = 'Disco Cater <orders@discocater.com>'
// Every Disco-native email sent from orders@discocater.com is also bcc'd to
// FM, across all restaurants — not conditional on restaurant, template, or
// any existing bcc the caller already set (e.g. sendRestaurantOrderNotification's
// per-order FM copy). Gated on the actual From address, not just "did the
// caller not override it", so a future caller that explicitly sends from a
// different address is correctly excluded — this must never touch FM-sourced
// order emails (which come from FM's own Java backend, mg.familymeal.com, and
// never call this function at all).
const ORDERS_BCC = 'noreply@familymeal.com'

export async function sendEmail(params: SendEmailParams): Promise<SendResult> {
  const apiKey = process.env.MAILGUN_API_KEY
  const domain = process.env.MAILGUN_DOMAIN

  if (!apiKey || !domain) {
    console.warn('[email/send] Mailgun not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN) — skipping email:', params.subject)
    return { success: false }
  }
  if (!params.to) {
    console.warn('[email/send] no recipient — skipping email:', params.subject)
    return { success: false }
  }

  try {
    const from = params.from || DEFAULT_FROM
    const bccList = Array.from(new Set([
      ...(params.bcc ? [params.bcc] : []),
      ...(from.includes('orders@discocater.com') ? [ORDERS_BCC] : []),
    ]))

    const form = new FormData()
    form.append('from', from)
    form.append('to', params.to)
    form.append('subject', params.subject)
    form.append('html', params.html)
    if (params.replyTo) form.append('h:Reply-To', params.replyTo)
    if (bccList.length) form.append('bcc', bccList.join(','))
    for (const a of params.attachments || []) {
      // Blob accepts both a UTF-8 string and raw bytes (Uint8Array), so binary
      // attachments like the order PDF are appended without corruption.
      const part = typeof a.content === 'string' ? a.content : new Uint8Array(a.content)
      form.append('attachment', new Blob([part], { type: a.contentType || 'application/octet-stream' }), a.filename)
    }

    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64') },
      body: form,
    })

    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      const error = `Mailgun ${res.status}: ${raw.slice(0, 300)}`
      console.error(`[email/send] ${error} (subject: "${params.subject}")`)
      return { success: false, error }
    }

    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[email/send] send failed for "${params.subject}":`, error)
    return { success: false, error }
  }
}
