// How a customer found us — shared shape, parsing and bounds.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Nothing recorded acquisition. A fleet-wide column sweep for referrer / utm /
// campaign / landing / channel / medium / attribution turned up zero hits, and
// `document.referrer` was never read anywhere in the app. The only source-ish
// column was disco_orders.source_of_order, which splits 1P (/order/[slug]) from
// 3P (/restaurants/[slug]) and nothing else.
//
// disco_checkout_funnel_sessions could not answer it either: its first stage is
// DATE_TIME_SELECTED, which happens ON the restaurant page, so the whole table
// begins AFTER the customer has already arrived. It measures where people drop
// out of checkout, not how they got here. It is also purged at 90 days.
//
// So acquisition is captured into a first-party cookie on first load and copied
// onto disco_orders at placement, where it is durable and reportable.
//
// ── FIRST TOUCH vs LAST TOUCH ───────────────────────────────────────────────
// referrer / landing path / utm / click-id are FIRST-TOUCH within the cookie's
// life: once set they are never overwritten, so an internal navigation three
// pages later can't rewrite the landing page as "/restaurants/foo". `source`
// and `aiAssisted` are deliberately LAST-TOUCH — they describe which internal
// path led to THIS restaurant, which legitimately changes as the customer moves
// around the marketplace.
//
// ── WHAT THIS CANNOT DO, BY CONSTRUCTION ────────────────────────────────────
// • Organic search TERM is unanswerable. Google strips it; GA reports
//   "(not provided)". Search Console has queries but only in aggregate, never
//   joinable to an order. Do not add a column for it and do not infer one.
// • "direct" is NOT a channel. It is the bucket for UNKNOWN: a pasted link, an
//   app open, a QR code, a privacy browser that strips the referrer, or a
//   genuinely typed URL all land there. Report it as "unknown", never as a
//   marketing result.
// • Nothing before the cookie existed, and nothing across devices.

/** Which internal marketplace path led to the restaurant page. */
export type AcquisitionSource = 'map' | 'search' | 'chat' | 'browse' | 'direct'

export const ACQUISITION_SOURCES: AcquisitionSource[] = ['map', 'search', 'chat', 'browse', 'direct']

/** Human labels — the only place these strings are written for display. */
export const ACQUISITION_SOURCE_LABEL: Record<AcquisitionSource, string> = {
  map: 'Map',
  search: 'Search',
  chat: 'AI chat',
  browse: 'Browsed list',
  direct: 'Direct link',
}

export const ACQUISITION_COOKIE = 'disco_acq'
/** 30 days. Long enough to span a browse-then-return, short enough to stay honest
 *  about being a single-browser, single-device signal. */
export const ACQUISITION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/** Paid click identifiers, in priority order. */
export const CLICK_ID_PARAMS = ['gclid', 'fbclid', 'msclkid'] as const
export type ClickIdType = (typeof CLICK_ID_PARAMS)[number]

export const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

// Every value is length-capped before it is stored. These land in a cookie that
// a user can edit by hand and then in a DB column, so they are untrusted input:
// bound them here, once, rather than at each call site.
export const MAX_FIELD_LENGTH = 512

export interface Acquisition {
  /** Last-touch: which internal path led to the restaurant page. */
  source: AcquisitionSource | null
  /** First-touch: document.referrer at first load. '' when absent — see "direct" above. */
  referrer: string | null
  /** First-touch: the path the customer landed on. */
  landingPath: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
  clickId: string | null
  clickIdType: ClickIdType | null
  /** Last-touch: the customer went through the AI discovery intake at some point. */
  aiAssisted: boolean
  /** When the first touch was captured (ISO). */
  capturedAt: string | null
}

export const EMPTY_ACQUISITION: Acquisition = {
  source: null, referrer: null, landingPath: null,
  utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null,
  clickId: null, clickIdType: null, aiAssisted: false, capturedAt: null,
}

/** Trim + bound a single untrusted value. Empty string collapses to null so a
 *  blank referrer is stored as "we don't know", not as the empty string. */
export function boundField(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, MAX_FIELD_LENGTH)
}

/**
 * Parse the cookie value into a bounded Acquisition. Never throws — a malformed
 * or hand-edited cookie yields EMPTY_ACQUISITION rather than failing a checkout.
 *
 * The wire shape is deliberately short-keyed: this rides in a cookie on every
 * request, so the field names are one or two characters.
 */
export function parseAcquisitionCookie(raw: string | null | undefined): Acquisition {
  if (!raw) return { ...EMPTY_ACQUISITION }
  let obj: Record<string, unknown>
  try {
    const decoded = decodeURIComponent(raw)
    const parsed: unknown = JSON.parse(decoded)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_ACQUISITION }
    obj = parsed as Record<string, unknown>
  } catch {
    return { ...EMPTY_ACQUISITION }
  }
  const src = boundField(obj.s)
  const clickIdType = boundField(obj.cit)
  return {
    source: (ACQUISITION_SOURCES as string[]).includes(src ?? '') ? (src as AcquisitionSource) : null,
    referrer: boundField(obj.r),
    landingPath: boundField(obj.lp),
    utmSource: boundField(obj.us),
    utmMedium: boundField(obj.um),
    utmCampaign: boundField(obj.uc),
    utmTerm: boundField(obj.ut),
    utmContent: boundField(obj.un),
    clickId: boundField(obj.ci),
    clickIdType: (CLICK_ID_PARAMS as readonly string[]).includes(clickIdType ?? '') ? (clickIdType as ClickIdType) : null,
    aiAssisted: obj.ai === true,
    capturedAt: boundField(obj.t),
  }
}

/** True when there is nothing worth writing — avoids a pointless UPDATE. */
export function isEmptyAcquisition(a: Acquisition): boolean {
  return !a.source && !a.referrer && !a.landingPath && !a.utmSource && !a.utmMedium &&
    !a.utmCampaign && !a.utmTerm && !a.utmContent && !a.clickId && !a.aiAssisted
}

/**
 * The channel an order should be reported under. Deliberately coarse, and
 * deliberately honest about the unknown bucket.
 *
 * Precedence is paid → campaign → internal path → referrer → unknown, because a
 * gclid is a fact about how they arrived while "map" is a fact about the last
 * click before the restaurant page; when both exist the paid click is the
 * acquisition and the map is just navigation.
 */
export function acquisitionChannel(a: Acquisition): string {
  if (a.clickIdType === 'gclid') return 'Paid search (Google)'
  if (a.clickIdType === 'msclkid') return 'Paid search (Microsoft)'
  if (a.clickIdType === 'fbclid') return 'Paid social (Meta)'
  if (a.utmSource) return `Campaign: ${a.utmSource}${a.utmMedium ? ` / ${a.utmMedium}` : ''}`
  if (a.referrer) {
    const host = referrerHost(a.referrer)
    if (host) return `Referral: ${host}`
  }
  if (a.source && a.source !== 'direct') return `Marketplace: ${ACQUISITION_SOURCE_LABEL[a.source]}`
  // NOT a channel — the bucket for everything we could not observe.
  return 'Unknown / direct'
}

/** Hostname of a referrer, or null. Internal referrers are dropped: arriving
 *  from our own site is navigation, not acquisition. */
export function referrerHost(referrer: string | null): string | null {
  if (!referrer) return null
  try {
    const h = new URL(referrer).hostname.replace(/^www\./, '')
    if (!h) return null
    if (h === 'discocater.com' || h.endsWith('.discocater.com')) return null
    return h
  } catch {
    return null
  }
}

// ── SERVER SIDE ─────────────────────────────────────────────────────────────

/**
 * Copy the acquisition cookie onto an order, by order reference.
 *
 * Written as its own UPDATE rather than threaded into the placement INSERTs on
 * purpose. There are two customer placement paths — the FM-backed insert in
 * app/api/order/place/route.ts and placeNativeOrder in
 * lib/order/native-checkout.ts — and both are money-critical. Attribution is
 * reporting metadata: it must never be able to fail, slow, or alter a
 * placement, so it runs after the order exists and swallows everything.
 *
 * Idempotent and non-destructive: COALESCE keeps whatever is already there, so
 * a retry or a double-fire cannot blank a value that was captured first.
 */
export async function recordOrderAcquisition(
  sqlClient: {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  },
  orderReference: string,
  acq: Acquisition,
): Promise<void> {
  if (!orderReference || isEmptyAcquisition(acq)) return
  await sqlClient`
    UPDATE disco_orders SET
      acq_source        = COALESCE(disco_orders.acq_source, ${acq.source}),
      acq_referrer      = COALESCE(disco_orders.acq_referrer, ${acq.referrer}),
      acq_landing_path  = COALESCE(disco_orders.acq_landing_path, ${acq.landingPath}),
      acq_utm_source    = COALESCE(disco_orders.acq_utm_source, ${acq.utmSource}),
      acq_utm_medium    = COALESCE(disco_orders.acq_utm_medium, ${acq.utmMedium}),
      acq_utm_campaign  = COALESCE(disco_orders.acq_utm_campaign, ${acq.utmCampaign}),
      acq_utm_term      = COALESCE(disco_orders.acq_utm_term, ${acq.utmTerm}),
      acq_utm_content   = COALESCE(disco_orders.acq_utm_content, ${acq.utmContent}),
      acq_click_id      = COALESCE(disco_orders.acq_click_id, ${acq.clickId}),
      acq_click_id_type = COALESCE(disco_orders.acq_click_id_type, ${acq.clickIdType}),
      acq_ai_assisted   = COALESCE(disco_orders.acq_ai_assisted, ${acq.aiAssisted}),
      acq_captured_at   = COALESCE(disco_orders.acq_captured_at, ${acq.capturedAt}::timestamptz)
    WHERE reference = ${orderReference}::uuid
  `
}
