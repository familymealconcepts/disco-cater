// "Did you mean ...?" for an email address with a known domain typo (Kevin, 2026-10-23): order
// emails to gmail.con or gmai.com bounce, and the diner or restaurant never hears about the order.
//
// THE LIST IS SHARED WITH noise-machine. lib/email-typo-domains.json is a byte-identical copy of
// noise-machine's scripts/tests/emailTypoDomains.shared.json, where NM OS's own typo list is pinned to
// it. Edit one copy, edit the other in the same change, and check `shasum -a 256` on both. Neither
// CI can see the other repo. scripts/tests/email-typo.test.ts runs every vector in the file.
//
// WARN ONLY. A listed domain can be real (gmal.com exists), so nothing that calls this may block a
// checkout or a save. It only offers a corrected address to tap.
import shared from './email-typo-domains.json'

const EXACT = shared.exact as Record<string, string>
const ENDINGS = shared.endings as Record<string, string>

/**
 * The corrected address, or null when there is nothing to suggest. Trims; the domain is everything
 * after the LAST @, matched lowercased; the local part is kept exactly as typed. A listed domain is
 * replaced whole; otherwise a last label in the endings list (.con, .cmo, ...) becomes .com.
 */
export function suggestEmailCorrection(email: string | null | undefined): string | null {
  const v = (email ?? '').trim()
  const at = v.lastIndexOf('@')
  if (at <= 0) return null
  const local = v.slice(0, at)
  const domain = v.slice(at + 1).toLowerCase()
  const dot = domain.lastIndexOf('.')
  if (dot <= 0) return null
  const exact = EXACT[domain]
  if (exact) return `${local}@${exact}`
  const ending = ENDINGS[domain.slice(dot + 1)]
  if (ending) return `${local}@${domain.slice(0, dot + 1)}${ending}`
  return null
}

/** The domain part of a suggested address, for the "Use {corrected domain}" button. */
export function emailDomainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1)
}
