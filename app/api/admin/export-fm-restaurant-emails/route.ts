import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// One-time export of EVERY FamilyMeal restaurant's admin email (active + inactive),
// which lives in FM, not Neon. Paginates FM's admin restaurant list via the
// SUPER_ADMIN service account (the same auth the super-admin list + syncs use),
// dedupes by email, applies the same test-email exclusions as the other exports,
// and returns a downloadable CSV. Admin-gated.
//   ?preview=1 → JSON summary (counts + a sample of exclusions), no file.
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const PAGE_SIZE = 200
const MAX_PAGES = 300

// Same rules as the restaurant/customer CSV exports. Returns the reason if excluded.
function excludeReason(e: string): string {
  const s = e.toLowerCase().trim()
  if (/@disco-test\.invalid$/.test(s)) return '@disco-test.invalid'
  if (/\.invalid$/.test(s)) return '.invalid TLD'
  if (/^chef\+/.test(s)) return 'chef+ test pattern'
  if (/^playwright\+/.test(s)) return 'playwright+ test fixture'
  if (/@(example\.(com|org|net)|test\.com)$/.test(s)) return 'example/test domain'
  if (/@yopmail\.com$/.test(s)) return 'yopmail (disposable/test)'
  if (/^test@/.test(s) || /\+test@/.test(s)) return 'test@ pattern'
  return ''
}
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const preview = req.nextUrl.searchParams.get('preview') === '1'

  try {
    let header = await getFmServiceAuthHeader()
    // email → { name, reference } (first restaurant wins; dedup is by email).
    const byEmail = new Map<string, { name: string; reference: string }>()
    const excluded = new Map<string, string>() // email → reason
    let scanned = 0

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${FM}/api/admin/restaurants?page=${page}&size=${PAGE_SIZE}`
      let res = await fetch(url, { headers: { ...header, Accept: 'application/json' }, cache: 'no-store' })
      if (res.status === 401) { header = await getFmServiceAuthHeader(true); res = await fetch(url, { headers: { ...header, Accept: 'application/json' }, cache: 'no-store' }) }
      if (!res.ok) {
        if (page === 0) {
          const raw = await res.text().catch(() => '')
          return NextResponse.json({ error: 'Failed to load restaurants from FM', status: res.status, raw: raw.slice(0, 300) }, { status: res.status })
        }
        break // partial list — proceed with what we have
      }
      const data = await res.json().catch(() => null) as { content?: Record<string, unknown>[]; totalPages?: number } | null
      const content = Array.isArray(data?.content) ? data!.content! : []
      for (const r of content) {
        scanned++
        const admin = (r.admin ?? {}) as Record<string, unknown>
        const email = String(r.adminEmail ?? admin.email ?? '').trim().toLowerCase()
        if (!email || !email.includes('@')) continue
        const reason = excludeReason(email)
        if (reason) { excluded.set(email, reason); continue }
        if (!byEmail.has(email)) {
          byEmail.set(email, {
            name: String(r.businessName ?? r.name ?? r.restaurantName ?? ''),
            reference: String(r.reference ?? ''),
          })
        }
      }
      const totalPages = typeof data?.totalPages === 'number' ? data.totalPages : undefined
      if (content.length < PAGE_SIZE || (totalPages !== undefined && page + 1 >= totalPages)) break
    }

    if (preview) {
      return NextResponse.json({
        scannedRestaurants: scanned,
        uniqueEmails: byEmail.size,
        excludedCount: excluded.size,
        excludedSample: [...excluded.entries()].slice(0, 40).map(([e, reason]) => `${e}  [${reason}]`),
      })
    }

    const rows = [...byEmail.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const csv = ['restaurant_name,reference,adminEmail',
      ...rows.map(([email, v]) => [csvCell(v.name), csvCell(v.reference), csvCell(email)].join(','))].join('\n') + '\n'

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="fm-restaurant-emails.csv"',
        'X-Unique-Emails': String(byEmail.size),
        'X-Excluded': String(excluded.size),
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[export-fm-restaurant-emails] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
