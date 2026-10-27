// Server-side: can this diner email's domain receive mail? (Peter, 27 Oct 2026)
//
// A domain with no mail (MX) records — gmail.vom, gmail.con, gmial.com — can
// never receive the order confirmation, receipts or a password reset, so the
// address is refused with a clear message and, when there is one, the "Did you
// mean …?" correction from lib/diner-email-suggest.ts.
//
// FAILS OPEN. Only a definite answer refuses: the domain does not exist
// (ENOTFOUND), has no MX records (ENODATA), or publishes a "null MX" (RFC 7505:
// a single empty exchange, "this domain accepts no mail" — gmail.co, yahoo.co).
// A timeout, a SERVFAIL or any other lookup error ALLOWS the address: a slow DNS
// server must never cost a real customer their order.
//
// Diner entry points only — checkout, sign-up. Restaurant Direct Entry and
// existing accounts are deliberately not checked.
import { Resolver } from 'node:dns/promises'
import { suggestDinerEmail } from './diner-email-suggest'

const TIMEOUT_MS = 2500
const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; receives: boolean }>()

export type DinerEmailCheck = { ok: true } | { ok: false; error: string; suggestion: string | null }

async function domainReceivesMail(domain: string): Promise<boolean> {
  const hit = cache.get(domain)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.receives
  const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 })
  let receives = true
  try {
    const timer = new Promise<'timeout'>(res => setTimeout(() => res('timeout'), TIMEOUT_MS + 500))
    const mx = await Promise.race([resolver.resolveMx(domain), timer])
    if (mx === 'timeout') return true // not cached: try again next time
    receives = mx.some(r => r.exchange && r.exchange !== '.')
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === 'ENOTFOUND' || code === 'ENODATA') receives = false
    else return true // lookup failed: allow, and don't cache the failure
  }
  cache.set(domain, { at: Date.now(), receives })
  return receives
}

/** Refuses only a domain that definitely cannot receive mail. */
export async function checkDinerEmailDomain(raw: string | null | undefined): Promise<DinerEmailCheck> {
  const email = String(raw ?? '').trim()
  const at = email.lastIndexOf('@')
  const domain = at > 0 ? email.slice(at + 1).toLowerCase().replace(/\.$/, '') : ''
  if (!domain) return { ok: true } // the format check is someone else's job
  try {
    if (await domainReceivesMail(domain)) return { ok: true }
  } catch {
    return { ok: true }
  }
  const suggestion = suggestDinerEmail(email)
  return {
    ok: false,
    suggestion,
    error: suggestion
      ? `We can't send email to ${email} — "${domain}" can't receive mail. Did you mean ${suggestion}?`
      : `We can't send email to ${email} — "${domain}" can't receive mail. Please check the spelling.`,
  }
}
