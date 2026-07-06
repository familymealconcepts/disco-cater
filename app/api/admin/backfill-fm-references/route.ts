import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// One-time repair: backfill disco_restaurant_accounts.fm_restaurant_reference for
// accounts onboarded before we stored it. For each Disco account missing the link,
// search FM's admin restaurant list by the restaurant name and match the row whose
// admin email equals the Disco account email — that row's `reference` is the FM
// restaurant reference. Admin-gated. Body: { dryRun?: boolean, email?: string }.
export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as { dryRun?: boolean; email?: string; diagnose?: boolean }
  const dryRun = body?.dryRun === true
  const diagnose = body?.diagnose === true
  const onlyEmail = String(body?.email || '').trim().toLowerCase()

  try {
    await runMigrations()
    // Candidates: EVERY Disco account not yet linked. We do NOT require
    // fm_user_reference — an account can have an FM restaurant (created at onboarding
    // and visible in the super-admin list) even when its FM user ref was never
    // stored in Neon. We need a restaurant_name to search FM by; accounts with no FM
    // record simply won't match (harmless). `email` narrows it to one for testing.
    const accounts = (onlyEmail
      ? await sql`
          SELECT email, restaurant_name FROM disco_restaurant_accounts
          WHERE fm_restaurant_reference IS NULL AND LOWER(email) = ${onlyEmail}`
      : await sql`
          SELECT email, restaurant_name FROM disco_restaurant_accounts
          WHERE fm_restaurant_reference IS NULL
            AND email IS NOT NULL AND email <> ''
            AND restaurant_name IS NOT NULL AND restaurant_name <> ''
            -- Either a known FM record (fm_user_reference) OR Stripe-connected (which
            -- means it onboarded → has an FM record → appears in super-admin and needs
            -- the link). Excludes abandoned test accounts with neither.
            AND (fm_user_reference IS NOT NULL
                 OR (stripe_account_id IS NOT NULL AND stripe_onboarding_complete = true))`) as { email: string; restaurant_name: string | null }[]

    if (!accounts.length) return NextResponse.json({ scanned: 0, linked: 0, unmatched: 0, details: [] })

    // DIAGNOSE: don't match/update — return exactly what FM's search sends back for
    // each account so we can see WHY it doesn't match (name not found, email under a
    // different key, different admin email, reference elsewhere, etc.).
    if (diagnose) {
      let dh = await getFmServiceAuthHeader()
      const out: unknown[] = []
      for (const acc of accounts) {
        const name = (acc.restaurant_name || '').trim()
        const target = acc.email.toLowerCase()
        const url = `${FM}/api/admin/restaurants?size=50&searchName=${encodeURIComponent(name)}`
        let res = await fetch(url, { headers: dh, cache: 'no-store' })
        if (res.status === 401) { dh = await getFmServiceAuthHeader(true); res = await fetch(url, { headers: dh, cache: 'no-store' }) }
        const data = res.ok ? (await res.json().catch(() => null)) as { content?: Record<string, unknown>[]; totalElements?: number } | null : null
        const list = Array.isArray(data?.content) ? data!.content! : []
        const results = list.slice(0, 15).map((r) => {
          const admin = (r.admin ?? {}) as Record<string, unknown>
          return {
            reference: r.reference ?? null,
            name: r.businessName ?? r.name ?? r.restaurantName ?? null,
            adminEmail: r.adminEmail ?? null,
            admin_dot_email: admin.email ?? null,
            // any other string field whose key looks like an email
            otherEmailFields: Object.entries(r).filter(([k, v]) => /email/i.test(k) && typeof v === 'string').map(([k, v]) => `${k}=${v}`),
            topLevelKeys: Object.keys(r),
          }
        })
        out.push({
          email: acc.email, restaurantName: name, searchName: name,
          fmStatus: res.status, totalElements: data?.totalElements ?? null, resultCount: list.length,
          emailMatchFound: list.some((r) => String(r.adminEmail ?? (r.admin as Record<string, unknown>)?.email ?? '').toLowerCase() === target),
        })
        ;(out[out.length - 1] as Record<string, unknown>).results = results
      }
      return NextResponse.json({ diagnose: true, accounts: out })
    }

    let header = await getFmServiceAuthHeader()
    const linked: { email: string; fmRestaurantReference: string }[] = []
    const unmatched: string[] = []

    for (const acc of accounts) {
      const name = (acc.restaurant_name || '').trim()
      if (!name) { unmatched.push(acc.email); continue }
      let res = await fetch(`${FM}/api/admin/restaurants?size=50&searchName=${encodeURIComponent(name)}`, { headers: header, cache: 'no-store' })
      if (res.status === 401) {
        header = await getFmServiceAuthHeader(true)
        res = await fetch(`${FM}/api/admin/restaurants?size=50&searchName=${encodeURIComponent(name)}`, { headers: header, cache: 'no-store' })
      }
      if (!res.ok) { unmatched.push(acc.email); continue }
      const data = await res.json().catch(() => null) as { content?: Record<string, unknown>[] } | null
      const list = Array.isArray(data?.content) ? data!.content! : []
      const target = acc.email.toLowerCase()
      const match = list.find((r) => {
        const admin = (r.admin ?? {}) as Record<string, unknown>
        const em = String(r.adminEmail ?? admin.email ?? '').toLowerCase()
        return em === target && !!r.reference
      })
      if (match?.reference) {
        const fmRef = String(match.reference)
        if (!dryRun) await sql`UPDATE disco_restaurant_accounts SET fm_restaurant_reference = ${fmRef}, updated_at = NOW() WHERE LOWER(email) = ${target}`
        linked.push({ email: acc.email, fmRestaurantReference: fmRef })
      } else {
        unmatched.push(acc.email)
      }
    }

    return NextResponse.json({ dryRun, scanned: accounts.length, linked: linked.length, unmatched: unmatched.length, details: linked, unmatchedEmails: unmatched })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[backfill-fm-references] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
