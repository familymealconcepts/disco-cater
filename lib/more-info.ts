// "More Info": an optional per-location note for diners (parking, pickup instructions, catering
// policies), shown behind a "More info" button under the address on the ordering page.
//
// Client-safe: pure text helpers only. Reading and writing the column is lib/more-info-store.ts.
//
// Stored on disco_restaurant_overrides.more_info for every restaurant, native or FM-backed — it is
// a Disco-only field and never goes to FamilyMeal. Written by exactly two routes:
//   /api/restaurant/more-info              the restaurant portal (same write check as disco-settings)
//   /api/admin/restaurants/[ref]/more-info Super Admin
//
// ── PLAIN TEXT WITH LINKS, NEVER HTML ───────────────────────────────────────────────────────
// The text is stored exactly as typed (after normalizeMoreInfo) and rendered as React text nodes
// and <a> elements built from moreInfoSegments(). Nothing is ever passed to
// dangerouslySetInnerHTML, so a "<script>" a restaurant types renders as those characters. Links
// are only http(s): a "javascript:" URL is not matched and stays text.
export const MORE_INFO_MAX = 2000
export const MORE_INFO_HINT = 'Optional. Extra details for diners, e.g. parking, pickup instructions, catering policies.'

/**
 * Trimmed, \r\n folded to \n, control characters other than newline and tab removed, runs of more
 * than two blank lines collapsed, capped at MORE_INFO_MAX. Empty becomes null (the field is unset).
 */
export function normalizeMoreInfo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MORE_INFO_MAX)
    .trim()
  return text || null
}

export type MoreInfoSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string }

// http(s):// or www. followed by non-space; trailing sentence punctuation is peeled off below.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi

/** The text split into plain runs and links. Newlines stay inside text runs (render with pre-wrap). */
export function moreInfoSegments(text: string): MoreInfoSegment[] {
  const out: MoreInfoSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // "see www.x.com." / "(https://x.com)" — the closing punctuation belongs to the sentence.
    while (/[.,;:!?)\]}]$/.test(url)) {
      if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break
      url = url.slice(0, -1)
    }
    const start = m.index ?? 0
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) })
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`
    try {
      const u = new URL(href)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push({ kind: 'link', text: url, href: u.toString() })
      else out.push({ kind: 'text', text: url })
    } catch {
      out.push({ kind: 'text', text: url })
    }
    last = start + url.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
