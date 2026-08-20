// Single Mailgun sender for Disco Cater transactional email.
//
// Mirrors the hand-rolled Mailgun HTTP pattern already used in
// app/api/cron/recurring-orders/route.ts and app/api/become-a-partner — no SDK.
// This is additive; those existing senders are left untouched.
//
// Contract: NEVER throws. Always resolves to a result object so callers can
// fire-and-forget without risking an unhandled rejection.

import { htmlToText } from './htmlToText'

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  /** Plain-text part. Omit this — sendEmail derives it from `html` automatically (see
   *  htmlToText.ts) so every caller gets multipart/alternative for free and there's no
   *  hand-written text version to drift out of sync with the HTML. Only pass this to
   *  override the derived text for a specific message. */
  text?: string
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
  /** Mailgun's own message id (the `id` field on a successful send response,
   *  e.g. "<20260819...@mg.discocater.com>") — lets a caller look up delivery
   *  status later via Mailgun's Events API instead of just trusting the 200. */
  id?: string
}

// Every sender in this app uses @discocater.com (root) in the visible From,
// not @mg.discocater.com (the actual Mailgun-verified domain — the root domain
// isn't even registered in Mailgun, confirmed via its Domains API: 404).
// This works ONLY because discocater.com's own DMARC record uses RELAXED
// alignment (adkim=r; aspf=r) — mg.discocater.com shares discocater.com's
// organizational domain, so SPF/DKIM alignment passes under relaxed mode even
// though the visible From domain doesn't literally match the signing domain.
// If discocater.com's DMARC is ever tightened to strict (adkim=s; aspf=s),
// EVERY email this app sends fails alignment at once. Deliberately NOT
// switching to @mg.discocater.com to fix this — that would expose the ugly
// subdomain to every recipient, a real cost, against a risk that's contingent
// on someone else's future DNS change. Documenting the dependency instead:
// if DMARC on the root domain ever needs tightening, whoever does that must
// know Mailgun sending depends on it staying relaxed.
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
// Kealoha wants a copy of every outbound Disco Cater email, unconditionally —
// unlike ORDERS_BCC this isn't gated on the From address, so it applies across
// every template/caller of sendEmail(). She filters on her end.
const KEALOHA_BCC = 'kealoha@discocater.com'
// Default Reply-To so any reply lands in Kealoha's inbox. Callers that need a
// different Reply-To (currently only the concierge conversion invite email,
// by design) pass their own params.replyTo, which wins over this default.
const DEFAULT_REPLY_TO = 'kealoha@discocater.com'

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
      KEALOHA_BCC,
    ]))
    const replyTo = params.replyTo || DEFAULT_REPLY_TO

    // Providing both html and text makes Mailgun send true multipart/alternative — no
    // caller needs to opt into this, it's just always both parts now.
    const text = params.text ?? htmlToText(params.html)

    const form = new FormData()
    form.append('from', from)
    form.append('to', params.to)
    form.append('subject', params.subject)
    form.append('html', params.html)
    form.append('text', text)
    if (replyTo) form.append('h:Reply-To', replyTo)
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

    const body = await res.json().catch(() => ({} as { id?: string }))
    return { success: true, id: body?.id }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[email/send] send failed for "${params.subject}":`, error)
    return { success: false, error }
  }
}
