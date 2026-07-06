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
  /** Optional file attachments (e.g. a scheduled-report CSV). */
  attachments?: { filename: string; content: string; contentType?: string }[]
}

export interface SendResult {
  success: boolean
  error?: string
}

const DEFAULT_FROM = 'Disco Cater <orders@discocater.com>'

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
    const form = new FormData()
    form.append('from', params.from || DEFAULT_FROM)
    form.append('to', params.to)
    form.append('subject', params.subject)
    form.append('html', params.html)
    if (params.replyTo) form.append('h:Reply-To', params.replyTo)
    if (params.bcc) form.append('bcc', params.bcc)
    for (const a of params.attachments || []) {
      form.append('attachment', new Blob([a.content], { type: a.contentType || 'application/octet-stream' }), a.filename)
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
