import crypto from 'node:crypto'
import { sql } from './db'

// Marketing/announcement-email opt-out — separate from Mailgun's own suppression
// list on purpose. mg.familymeal.com also carries mandatory transactional mail
// (order confirmations, reminders, receipts), and Mailgun suppression is
// domain-wide + per-recipient, not send-type-aware: adding someone to it would
// block those mandatory sends too. This table is consulted ONLY by
// marketing/announcement send scripts — never wire it into lib/email/send.ts or
// any transactional path.

const SITE_URL = 'https://www.discocater.com'

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function isOptedOutOfMarketing(email: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM marketing_email_opt_outs WHERE email = ${normalizeEmail(email)} LIMIT 1
  `
  return rows.length > 0
}

// Bulk variant for filtering a large send list in one round-trip instead of one
// query per recipient.
export async function filterOutMarketingOptOuts(emails: string[]): Promise<string[]> {
  const normalized = emails.map(normalizeEmail)
  const rows = (await sql`
    SELECT email FROM marketing_email_opt_outs WHERE email = ANY(${normalized})
  `) as { email: string }[]
  const optedOut = new Set(rows.map((r) => r.email))
  return emails.filter((e) => !optedOut.has(normalizeEmail(e)))
}

export async function optOutOfMarketing(email: string, source: string): Promise<void> {
  await sql`
    INSERT INTO marketing_email_opt_outs (email, opted_out_at, source)
    VALUES (${normalizeEmail(email)}, NOW(), ${source})
    ON CONFLICT (email) DO NOTHING
  `
}

// HMAC-signed token so a link can't be used to unsubscribe an arbitrary address
// that isn't the intended recipient. Not secret-sensitive data, just tamper-proofing.
function sign(email: string): string {
  const secret = process.env.UNSUBSCRIBE_SECRET
  if (!secret) throw new Error('UNSUBSCRIBE_SECRET is not set')
  return crypto.createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex')
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  try {
    const expected = sign(email)
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
  } catch {
    return false
  }
}

export function buildUnsubscribeUrl(email: string): string {
  const token = sign(email)
  return `${SITE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
}
