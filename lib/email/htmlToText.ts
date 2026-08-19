// Derives a plain-text part from an email's HTML, so sendEmail() can always send
// multipart/alternative without every caller hand-writing (and inevitably drifting from) its
// own text version. Every template in this app is simple, known markup (layout()'s shell,
// <p>/<strong>/<a>/<hr>, and a couple of plain <table> layouts for line items/totals in
// notifications.ts) -- this is not a general-purpose HTML-to-text library, just enough to
// handle exactly that shape correctly. No external dependency, same hand-rolled convention as
// the rest of lib/email/.
//
// Order of operations matters: links are extracted BEFORE generic tag-stripping (a stripped
// <a href> loses the URL forever), block-level tags become newlines before their own tags are
// removed, then everything else is stripped and entities decoded.

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&emsp;/gi, '  ')
}

export function htmlToText(html: string): string {
  let text = html
    // Non-content blocks first -- <head>'s <link>/<meta> have no inner text, but strip the
    // whole thing anyway rather than relying on that.
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Images contribute no text worth keeping in a plain-text email.
    .replace(/<img[^>]*>/gi, '')
    // Links -> "label (url)", before anything strips the href away. Inner content can itself
    // carry simple markup (e.g. <strong>), so it's tag-stripped separately, not assumed plain.
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim()
      return label ? `${label} (${href})` : href
    })
    // Table cells: a tab-ish gap between columns, not a newline -- a line item's name and its
    // price belong on the same line.
    .replace(/<\/(td|th)>/gi, '   ')
    // Block-level boundaries -> single newline.
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Divider rule -> a plain-text divider, matching how these templates use <hr> as a section
    // break (see notifications.ts's HR constant).
    .replace(/<hr\b[^>]*>/gi, '\n----------\n')
    // Everything else (table/tbody/span/strong/div open tags, etc.) contributes no text of its
    // own -- just remove the tags and keep whatever text was between them.
    .replace(/<[^>]+>/g, '')

  text = decodeEntities(text)

  // Collapse trailing spaces per line and excess blank lines, without collapsing intentional
  // single blank lines between paragraphs.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}
