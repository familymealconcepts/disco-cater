// Shared helper: pull a usable public image URL out of an FM image reference.
// FM stores images as a reference (UUID) served via its own public, unauthenticated,
// by-reference download endpoint (GET /public-api/images/{reference}/download —
// FilePublicApiController.java, permitAll) — not a ready-made CDN URL. This accepts
// a direct http(s) URL if the caller's payload already has one (e.g. an upload
// response), otherwise builds the public download URL from whatever reference it
// carries. Returns null when neither is present.
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export function fmImageUrl(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, any>
  for (const k of ['url', 'imageUrl', 'publicUrl', 'location']) {
    const v = o[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  const ref: unknown =
    o.reference ?? o.image?.reference ?? o.marketplaceImage?.image?.reference ?? o.marketplaceImage?.reference
  if (typeof ref === 'string' && ref) return `${FM}/public-api/images/${ref}/download?size=600`
  return null
}
