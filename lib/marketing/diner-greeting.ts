// Turn fm_customers.first_name into something safe to put after "Hi ".
//
// ── WHY THIS IS NOT `first_name.split(' ')[0]` ─────────────────────────────
// The real column, measured across 17,776 rows / 4,353 distinct values, holds
// plenty that is not one person's first name:
//
//   "Dave and Angie"   "Kris and Scott"   "Diana & Miguel"   "Carly/Rich"
//   "Robert or Lily"   "Amy and/or Mark"  "Bridget or Sean"  "David / Gynur"
//   "Corrie Wolff OR " "Karen' and Steven "  "Elena and Hazel :-)"
//   "National Grid Ventures"   "Point Pleasant Fire Department"
//   "G"  "J"  "K"  "D"  "P"  "K2"
//   "TestIM3rd"  "Selfdelivorder1"  "3rdPartyorder1"  "IMOrder2"  "Pickuporder1"
//
// 58 rows across 52 values are one of these shapes. Small, but "Hi Alison and,"
// in 13,776 sends is the kind of thing a person screenshots.
//
// The rule: take the first PERSON out of a joint name, keep it only if it still
// looks like a name, and fall back to "there" otherwise. "Dave and Angie"
// greets Dave, which is friendlier than "there" and cannot read as broken.
// Anything uncertain gets "there" — the same standard the restaurant campaign
// used, where an unusable greeting fell back rather than being guessed at.

export const FALLBACK_GREETING = 'there'

/** Words that mean "a second person follows", so everything after is dropped. */
const JOINERS = /\s*(?:\band\/or\b|\band\b|\bor\b|&|\+|\/|,|;)\s*/i

/** A full value that is clearly an organisation, not a person. */
const ORG_WORDS = /\b(inc|llc|ltd|corp|corporation|company|co|group|ventures|department|dept|school|university|college|hospital|church|foundation|institute|society|club|team|office|catering|restaurant|kitchen|cafe|bakery)\b/i

/** A full value that is obviously a test or system record. */
const TEST_SHAPE = /test|order\d|\dparty|selfdeliv|pickuporder|shorten|^im\d|dummy|sample/i

/** What is left must look like a given name. Letters, and the marks real names
 *  carry — apostrophe, hyphen, accents. No digits, no punctuation, 2+ chars. */
const NAME_SHAPE = /^[\p{L}][\p{L}'’-]{1,}$/u

export function dinerGreeting(firstNameRaw: string | null | undefined): string {
  const raw = String(firstNameRaw ?? '').trim()
  if (!raw) return FALLBACK_GREETING

  // Judge the WHOLE value for org/test shape before splitting — "National Grid
  // Ventures" would otherwise survive as "National", and "Pickuporder1" as a
  // name-shaped token.
  if (ORG_WORDS.test(raw)) return FALLBACK_GREETING
  if (TEST_SHAPE.test(raw)) return FALLBACK_GREETING

  // First person only. "Dave and Angie" → "Dave"; "Corrie Wolff OR " → "Corrie
  // Wolff"; "Carly/Rich" → "Carly".
  const firstPerson = raw.split(JOINERS)[0]?.trim() ?? ''
  if (!firstPerson) return FALLBACK_GREETING

  // Then the first word of that, so "Corrie Wolff" greets "Corrie".
  const token = firstPerson.split(/\s+/)[0] ?? ''
  // Trailing punctuation a human typed is noise, not part of the name. The
  // apostrophe has to be stripped when it TRAILS ("Karen' and Steven" -> Karen)
  // while surviving inside a name (O'Brien), so the trailing strip runs after
  // the general one rather than being folded into its character class.
  const cleaned = token
    .replace(/^[^\p{L}]+/u, '')
    .replace(/[^\p{L}'’-]+$/u, '')
    .replace(/['’-]+$/u, '')
  if (!NAME_SHAPE.test(cleaned)) return FALLBACK_GREETING

  // ALL-CAPS and all-lower both read badly next to "Hi". Capitalise after an
  // apostrophe or hyphen too, so O'Brien and Jean-Luc come back intact rather
  // than as O'brien and Jean-luc.
  return cleaned.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase())
}
