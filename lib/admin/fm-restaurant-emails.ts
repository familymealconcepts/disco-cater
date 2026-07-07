// One page of FamilyMeal restaurant admin emails, for the batched export. Kept out
// of the route so it can be unit-tested with a mocked FM. The route just adds admin
// auth; the client loops pages (dedup + CSV happen client-side) with live progress,
// so no single request has to walk the whole (thousands-of-rows) list.
import { getFmServiceAuthHeader } from '../fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Same test-email exclusion rules as the restaurant/customer CSV exports.
export function fmEmailExcludeReason(email: string): string {
  const s = email.toLowerCase().trim()
  if (/@disco-test\.invalid$/.test(s)) return '@disco-test.invalid'
  if (/\.invalid$/.test(s)) return '.invalid TLD'
  if (/^chef\+/.test(s)) return 'chef+ test pattern'
  if (/^playwright\+/.test(s)) return 'playwright+ test fixture'
  if (/@(example\.(com|org|net)|test\.com)$/.test(s)) return 'example/test domain'
  if (/@yopmail\.com$/.test(s)) return 'yopmail (disposable/test)'
  if (/^test@/.test(s) || /\+test@/.test(s)) return 'test@ pattern'
  return ''
}

export interface FmEmailPage {
  page: number
  totalPages: number
  done: boolean
  scannedThisPage: number
  excludedThisPage: number
  rows: { restaurant_name: string; reference: string; adminEmail: string }[]
}

// Fetch + filter a single page of FM restaurants. Rows are test-excluded here;
// cross-page dedup is the caller's job (the client loop).
export async function fetchFmRestaurantEmailPage(page: number, size = 200): Promise<FmEmailPage> {
  let header = await getFmServiceAuthHeader()
  const url = `${FM}/api/admin/restaurants?page=${page}&size=${size}`
  let res = await fetch(url, { headers: { ...header, Accept: 'application/json' }, cache: 'no-store' })
  if (res.status === 401) { header = await getFmServiceAuthHeader(true); res = await fetch(url, { headers: { ...header, Accept: 'application/json' }, cache: 'no-store' }) }
  if (!res.ok) throw new Error(`FM ${res.status}`)

  const data = await res.json().catch(() => null) as { content?: Record<string, unknown>[]; totalPages?: number } | null
  const content = Array.isArray(data?.content) ? data!.content! : []
  const totalPages = typeof data?.totalPages === 'number' ? data.totalPages : page + 1

  const rows: FmEmailPage['rows'] = []
  let excludedThisPage = 0
  for (const r of content) {
    const admin = (r.admin ?? {}) as Record<string, unknown>
    const email = String(r.adminEmail ?? admin.email ?? '').trim().toLowerCase()
    if (!email || !email.includes('@')) continue
    if (fmEmailExcludeReason(email)) { excludedThisPage++; continue }
    rows.push({
      restaurant_name: String(r.businessName ?? r.name ?? r.restaurantName ?? ''),
      reference: String(r.reference ?? ''),
      adminEmail: email,
    })
  }
  const done = content.length < size || page + 1 >= totalPages
  return { page, totalPages, done, scannedThisPage: content.length, excludedThisPage, rows }
}
