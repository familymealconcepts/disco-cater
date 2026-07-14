// Resolve a restaurant image src to a right-sized, CDN-optimized URL.
//
// Restaurant images in disco_restaurant_cache are stored as BARE Sanity CDN URLs
// (the original asset — often multi-MB, up to ~6600px / 1.9MB). Rendered directly
// in a small card that means downloading megabytes per card + decoding huge
// bitmaps, which made the Favorites grid + calendar picker load slowly. Sanity's
// image CDN resizes + reformats on the fly, so appending w/h/fit/auto=format turns
// a 1.9MB original into a ~20-40KB thumbnail (98%+ smaller, WebP/AVIF where
// supported). Use this everywhere a restaurant image is shown in a card.

const FM_IMG_BASE = 'https://api.familymeal.com/public-api/images'

export function sizedImage(src?: string | null, width = 400, height?: number): string | undefined {
  if (!src) return undefined
  const s = String(src)
  // Sanity CDN → on-the-fly resize + modern format. Skip if the caller already
  // put a transform on it (respect an explicit ?w=/rect=/etc.).
  if (s.includes('cdn.sanity.io') && !s.includes('?')) {
    const h = height ?? Math.round(width * 0.68)
    return `${s}?w=${width}&h=${h}&fit=crop&auto=format`
  }
  // Already an absolute/relative URL (non-Sanity, or pre-transformed) → leave as-is.
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/')) return s
  // Bare string → legacy FM image reference UUID.
  return `${FM_IMG_BASE}/${s}/download?size=${width}`
}
