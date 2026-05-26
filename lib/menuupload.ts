// Helpers for the external menuupload service. The API key never leaves the
// Next.js server — all calls go through /api/admin/bulk-import/* proxies.

export const MENUUPLOAD_BASE =
  process.env.MENUUPLOAD_BASE_URL || 'https://menuuploadstg.familymeal.com'

export function menuuploadHeaders(): Record<string, string> {
  const key = process.env.MENUUPLOAD_API_KEY || ''
  return { 'x-api-key': key, Accept: 'application/json' }
}

// FM base64-encodes location IDs in their route. We accept either raw or
// base64, and try to decode if it looks base64.
export function maybeDecodeId(s: string): string {
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0 && s.length > 8) {
      const decoded = Buffer.from(s, 'base64').toString('utf8')
      // Only return decoded if it looks ascii-printable
      if (/^[\x20-\x7e]+$/.test(decoded)) return decoded
    }
  } catch {}
  return s
}
