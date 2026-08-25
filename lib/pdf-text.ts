/**
 * Make arbitrary user text safe to draw with pdf-lib's standard fonts.
 *
 * WHY THIS EXISTS. The standard 14 PDF fonts (Helvetica et al.) are encoded in
 * WinAnsi, which covers Latin-1 plus 27 extras and NOTHING ELSE. pdf-lib does
 * not substitute or skip a character it cannot encode — it THROWS, from deep
 * inside `widthOfTextAtSize`/`drawText`:
 *
 *     Error: WinAnsi cannot encode "‬" (0x202c)
 *
 * So one unmappable character anywhere in an order — a customer's name, a note,
 * a delivery instruction — takes down the entire PDF. That is not hypothetical:
 * order 900000094 (Hugo's Tacos Studio City) carried a U+202C POP DIRECTIONAL
 * FORMATTING in its delivery_instructions, invisibly, at the end of a phone
 * number a customer had pasted in. `/api/order/<ref>/pdf` returned HTTP 500 for
 * that order and the restaurant could not print it.
 *
 * THE ASYMMETRY IS THE WHOLE POINT. The text is cosmetic; the PDF is
 * functional. A restaurant needs the order sheet far more than it needs one
 * invisible codepoint faithfully reproduced, and a character nobody can see is
 * the worst possible thing to fail a print job over. So this NEVER throws and
 * never returns something undrawable: worst case it substitutes '?'.
 *
 * WHY IT ISN'T "just strip non-ASCII". Latin-1 accents (é, ñ, ü) and the curly
 * punctuation real restaurant names actually contain (DeCheco's U+2019, en
 * dashes) are all perfectly encodable, and mangling them would be a visible
 * regression on almost every order to fix a rare one. This keeps everything
 * WinAnsi genuinely supports, byte for byte.
 *
 * Deliberately its own module rather than a local helper in order-pdf.ts:
 * lib/restaurant-reports-pdf.ts renders user-supplied text through the same
 * standard fonts and has the same exposure (it has already crashed once on an
 * arrow glyph). It has NOT been repointed here yet — that is a follow-up, not
 * something to fold into an urgent fix — but the definition it should adopt is
 * this one rather than a second copy.
 */

// The 27 code points above U+00FF that WinAnsi does encode. Anything else
// outside Latin-1 does not exist in this encoding.
const WINANSI_ABOVE_LATIN1 = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

// Invisible formatting: dropped outright, because substituting '?' for
// something the author could not see would look like corruption. This is the
// class that caused the outage — bidi marks and zero-width joiners ride along
// on pasted phone numbers and addresses.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁪-⁯﻿]/

// Characters with an obvious ASCII reading, mapped rather than '?'-ed. Kept
// short on purpose: only things that genuinely show up in order text.
const TRANSLITERATE: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x',
  '≠': '!=', '≤': '<=', '≥': '>=', '×': 'x', '⁄': '/',
  '″': '"', '′': "'", '‑': '-', '‒': '-', '―': '-',
  ' ': ' ', ' ': ' ', '　': ' ',
}

/**
 * True when pdf-lib's WinAnsi encoder can render this code point as-is.
 *
 * CONTROL CHARACTERS ARE NOT ENCODABLE, including newline and tab. This is
 * counter-intuitive enough to state plainly, because an earlier version of this
 * file allowed \n and \t through on the assumption that whitespace must be
 * safe, and pdf-lib threw `WinAnsi cannot encode "\n" (0x000a)` on the seven
 * real orders that have a newline in a note or delivery instruction. WinAnsi is
 * a glyph table; a control character has no glyph, so it is exactly as fatal as
 * a Cyrillic letter. `cell()` draws one line per Ln entry and never relies on an
 * embedded newline, so folding these to a space loses nothing.
 */
function encodable(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true                   // ASCII printable
  // 0x80-0x9F is the C1 block: undefined in WinAnsi, so deliberately excluded.
  if (cp >= 0xa1 && cp <= 0xff) return true                   // Latin-1 proper
  return WINANSI_ABOVE_LATIN1.has(cp)
}

// Whitespace-ish characters folded to a plain space rather than dropped, so
// "line one\nline two" stays two readable words instead of "line oneline two".
const TO_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0xa0, 0x2028, 0x2029])

/**
 * Return `t` with every character pdf-lib cannot encode replaced by something
 * it can. Never throws. Idempotent, so applying it twice is harmless — which
 * matters because both the measuring and the drawing path call it.
 */
export function pdfSafe(t: string): string {
  if (!t) return ''
  // Fast path. The overwhelming majority of order text is plain Latin-1 and
  // this runs per text run, several hundred times per document.
  let clean = true
  for (const ch of t) { if (!encodable(ch.codePointAt(0)!)) { clean = false; break } }
  if (clean) return t

  let out = ''
  for (const ch of t) {
    const cp = ch.codePointAt(0)!
    if (encodable(cp)) { out += ch; continue }
    if (TO_SPACE.has(cp)) { out += ' '; continue }             // newline/tab/NBSP
    if (INVISIBLE.test(ch)) continue                          // drop, see above
    const mapped = TRANSLITERATE[ch]
    if (mapped) { out += mapped; continue }
    // Latin Extended (ā, ő, ř, ł…) reduces to a base letter WinAnsi has.
    // Decompose, drop the combining marks, keep it only if the result is fully
    // encodable — otherwise fall through rather than emit half a character.
    const folded = ch.normalize('NFD').replace(/\p{M}/gu, '')
    if (folded && [...folded].every((k) => encodable(k.codePointAt(0)!))) { out += folded; continue }
    // Genuinely unrepresentable (Cyrillic, CJK, emoji). '?' rather than nothing:
    // a name rendering as "???" tells whoever reads the sheet that text was
    // there and did not survive, where silence reads as an empty field.
    out += '?'
  }
  return out
}
