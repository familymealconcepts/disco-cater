// Shared filename construction for every endpoint that returns a downloadable
// file, and for the order PDF's email-attachment name. One module so the
// sanitising rules exist once: before this, the order PDF route named files
// after a truncated UUID, the email attachment used a bare order number, and
// the scheduled-report route carried its own inline regex — three encodings of
// "make this string safe to be a filename," none of them agreeing.
//
// WHY THE RESTAURANT NAME IS PART OF THE ORDER PDF NAME: disco_orders
// .order_number is unique PER RESTAURANT, not globally (the composite key is
// (restaurant_reference, order_number) — see the order-number uniqueness fix in
// noise-machine's CLAUDE.md for the incident that established this). Two
// restaurants can both have an order 900000093, so a filename of just the
// number is genuinely ambiguous once a file leaves the browser. Do not drop the
// restaurant name to shorten these.

// Windows forbids  < > : " / \ | ? *  and control chars; macOS forbids / and
// treats : specially. Rather than enumerate a denylist, everything that is not
// an ASCII alphanumeric becomes a hyphen — that is safe on both platforms and
// on every mail client that has to render the attachment name.
//
// Order of operations matters and is deliberate:
//   1. NFD + strip combining marks, so "Café" -> "Cafe" rather than "Caf".
//   2. Apostrophes are DELETED, not hyphenated, so "DeCheco's" -> "DeChecos"
//      rather than "DeCheco-s". Covers the ASCII ' and the curly U+2019 that
//      real restaurant names actually use — disco_restaurant_cache stores
//      "DeCheco’s Pizzeria - Fairlawn" with the smart quote, so handling only
//      the ASCII form would silently miss every real case.
//   3. "&" becomes "and" before the catch-all, since "-" there reads worse.
//   4. Everything else -> hyphen, runs collapsed, ends trimmed. Trimming the
//      ends is what stops " - " in a name (very common) or a trailing comma
//      producing a leading/trailing hyphen.
export function sanitizeFilenameSegment(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Total filename budget including the extension. Well inside every filesystem's
// per-component limit (255 bytes on ext4/APFS/NTFS) with room to spare, and
// short enough to stay readable in a mail client's attachment strip.
const MAX_FILENAME_LEN = 100

// Trim a name segment to fit, preferring a hyphen boundary so the result reads
// as truncated words rather than a word cut mid-syllable.
function clampSegment(segment: string, budget: number): string {
  if (budget <= 0) return ''
  if (segment.length <= budget) return segment
  const hard = segment.slice(0, budget)
  const lastHyphen = hard.lastIndexOf('-')
  // Only prefer the boundary if it isn't throwing away most of the budget.
  const cut = lastHyphen > budget * 0.5 ? hard.slice(0, lastHyphen) : hard
  return cut.replace(/-+$/, '')
}

/**
 * `[Restaurant-Name]-[order-number].pdf`, e.g.
 * `DeChecos-Pizzeria-Fairlawn-900000093.pdf`.
 *
 * Falls back in two independent ways, so this can never return something like
 * `-.pdf` or `undefined.pdf`:
 *   • no usable order number -> the order's reference UUID, which is always
 *     present and unique (a truncated ref was the old behaviour and is NOT
 *     used, since 8 hex chars is a weaker guarantee than the whole thing).
 *   • no usable restaurant name -> 'disco-cater-order', so the file still
 *     says what it is.
 */
export function orderPdfFilename(
  restaurantName: string | null | undefined,
  orderNumber: string | number | null | undefined,
  reference: string | null | undefined,
): string {
  const rawNumber = orderNumber == null ? '' : String(orderNumber).trim()
  // A stored order_number can legitimately be 0-length or whitespace on a row
  // that never synced; treat that the same as null.
  const idPart = sanitizeFilenameSegment(rawNumber) || sanitizeFilenameSegment(reference) || 'unknown'

  const namePart = sanitizeFilenameSegment(restaurantName) || 'disco-cater-order'

  const ext = '.pdf'
  // Budget: total - extension - the joining hyphen - the id, which is the part
  // that must survive intact (it is the actual identifier).
  const budget = MAX_FILENAME_LEN - ext.length - 1 - idPart.length
  const clampedName = clampSegment(namePart, budget) || 'order'
  return `${clampedName}-${idPart}${ext}`
}

/**
 * A Content-Disposition value that is safe to put in a header.
 *
 * Emits both `filename=` (quoted ASCII) and `filename*=UTF-8''…` (RFC 5987)
 * whenever the two would differ. Everything from sanitizeFilenameSegment is
 * already ASCII, so in practice only the plain form is emitted — but callers
 * that pass a name through unsanitised (a report title, say) would otherwise
 * be able to inject a `"` and truncate the header, so the escaping is real
 * rather than decorative.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  filename: string,
): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '')
  const encoded = encodeURIComponent(filename)
  const star = ascii === filename ? '' : `; filename*=UTF-8''${encoded}`
  return `${disposition}; filename="${ascii}"${star}`
}
