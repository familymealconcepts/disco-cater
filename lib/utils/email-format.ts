// Email FORMAT check for diner account creation. Client-safe (no server imports)
// so the signup page, the auth modal and every server route that creates a
// diner account share exactly one rule.
//
// Deliberately a shape check, not deliverability: one "@", something before it,
// a dotted domain after it with a 2+ character final label, no whitespace, and
// RFC 5321's 254-character ceiling. It exists because "not-an-email" created a
// real account (2026-10-22) — a row nobody could ever email a receipt or a
// reset link to. Plus-addressing ("name+tag@domain.com") is valid and allowed.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/

export const INVALID_EMAIL_MESSAGE = 'Please enter a valid email address, like name@example.com.'

export function isValidEmailFormat(raw: string | null | undefined): boolean {
  const email = String(raw ?? '').trim()
  if (!email || email.length > 254) return false
  return EMAIL_SHAPE.test(email)
}
