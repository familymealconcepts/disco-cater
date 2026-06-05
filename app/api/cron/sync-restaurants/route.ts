// Daily cron: sync active marketplace restaurants from FM into Sanity.
//
// Runs at 04:00 UTC (see vercel.json), one hour after regenerate-compact.
//
// REQUIRED ENV (set in Vercel → Project → Environment Variables):
//   CRON_SECRET        shared secret. Vercel Cron sends it as
//                      `Authorization: Bearer ${CRON_SECRET}`; also accepted for
//                      manual/CLI calls.
//   FM_ADMIN_EMAIL     FM SUPER_ADMIN/admin login email (server-to-server login).
//   FM_ADMIN_PASSWORD  FM admin login password.
//   SANITY_TOKEN       Sanity write token (server-only).
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — the super-admin "Sync Restaurants from FM" button, authorized by
//            the admin session cookie (so CRON_SECRET is never shipped to the
//            browser), or by the same Bearer secret.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Dedicated server-side WRITE client. The shared sanity/lib/client.ts is
// read-only (useCdn:true, no token) and imported widely, so we instantiate a
// write client here (matching scripts/importRestaurantsFromCSV.ts and
// app/api/admin/restaurant-marketplace/route.ts) rather than mutate it.
const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v)
    return isFinite(n) ? n : null
  }
  return null
}

function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ── FM types ─────────────────────────────────────────────────────────────────

interface FmAddress {
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  zipcode?: string
  latitude?: number | string
  longitude?: number | string
}
interface FmRestaurant {
  reference?: string
  businessName?: string
  businessNameWithoutSpaces?: string
  blocked?: boolean
  restaurantStatus?: string
  status?: string
  address?: FmAddress
}

// ── STEP 1 — FM admin login ──────────────────────────────────────────────────

async function fmLogin(): Promise<string> {
  const email = process.env.FM_ADMIN_EMAIL
  const password = process.env.FM_ADMIN_PASSWORD
  if (!email || !password) throw new Error('FM_ADMIN_EMAIL / FM_ADMIN_PASSWORD are not configured')

  const res = await fetch(`${FM}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`FM login failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const data = await res.json().catch(() => ({}))
  const token = String(data?.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('FM login returned no authorization token')
  return token
}

// ── STEP 2 — fetch all marketplace restaurants (paginated) ───────────────────

async function fetchAllMarketplace(token: string): Promise<FmRestaurant[]> {
  const out: FmRestaurant[] = []
  // Match the working admin marketplace page exactly: omit `page` when 0 and use
  // size=25. Sending `page=0` explicitly is what FM 400s on (the proxy + client
  // both only set `page` when > 0).
  const size = 25
  // 1000-page hard cap is a runaway-loop backstop, far above any real count.
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(size))
    const res = await fetch(`${FM}/api/admin/restaurants/marketplace?${params}`, {
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) {
      const errBody = await res.text()
      console.log('[sync] marketplace 400 body:', errBody)
    }
    if (!res.ok) throw new Error(`FM marketplace fetch failed (page ${page}, HTTP ${res.status})`)
    const d = await res.json().catch(() => null)
    const content: FmRestaurant[] = Array.isArray(d) ? d : (d?.content || d?.data || [])
    out.push(...content)

    const totalPages =
      typeof d?.totalPages === 'number' ? d.totalPages
      : typeof d?.totalElements === 'number' ? Math.ceil(d.totalElements / size)
      : null

    if (content.length === 0) break
    if (totalPages != null) { if (page + 1 >= totalPages) break }
    else if (content.length < size) break
  }
  return out
}

function isActive(r: FmRestaurant): boolean {
  const s = (r.restaurantStatus || r.status || '').toUpperCase()
  return s === 'ACTIVE'
}
function hasFullAddress(a?: FmAddress): boolean {
  if (!a) return false
  if (!a.addressLine1 || !a.city || !a.state || !a.zipcode) return false
  return num(a.latitude) != null && num(a.longitude) != null
}

// ── Sanity doc shape (only what we read for the merge) ───────────────────────

type SanityDoc = Record<string, unknown> & {
  _id?: string
  _rev?: string
  _type?: string
  _createdAt?: string
  _updatedAt?: string
  slug?: unknown
  isDisco?: boolean
  featured?: boolean
  cuisine?: string
  description?: string
}

// ── Core sync ─────────────────────────────────────────────────────────────────

async function runSync() {
  const errors: string[] = []
  let newCount = 0
  let updated = 0
  let deactivated = 0
  let skipped = 0

  // STEP 1
  const token = await fmLogin()

  // STEP 2
  const all = await fetchAllMarketplace(token)
  console.log(`[sync-restaurants] fetched ${all.length} marketplace restaurants from FM`)

  // Classify: qualifying (active + not blocked + full address/coords) vs skipped
  // (active + not blocked but missing address/coords). Inactive/blocked rows are
  // neither — they fall through to STEP 4 deactivation if present in Sanity.
  const qualifying: FmRestaurant[] = []
  for (const r of all) {
    if (!r.reference) continue
    const active = isActive(r)
    // "not blocked" — treat absent `blocked` as not blocked (FM marketplace
    // visibility), only excluding rows explicitly blocked === true.
    const notBlocked = r.blocked !== true
    if (!active || !notBlocked) continue
    if (hasFullAddress(r.address)) qualifying.push(r)
    else skipped++ // failed address/coordinates check
  }
  const qualifyingRefs = new Set(qualifying.map((r) => r.reference as string))
  console.log(`[sync-restaurants] ${qualifying.length} qualifying, ${skipped} skipped (address check)`)

  // STEP 3 — upsert each qualifying restaurant into Sanity.
  let processed = 0
  for (const r of qualifying) {
    const ref = r.reference as string
    const id = `restaurant.fm-${ref}`
    try {
      const a = r.address as FmAddress
      // FM fields — ALWAYS overwrite.
      const fmFields = {
        name: r.businessName || '',
        fmReference: ref,
        address: `${a.addressLine1}, ${a.city}, ${a.state} ${a.zipcode}`,
        location: `${a.city}, ${a.state}`,
        lat: num(a.latitude),
        lng: num(a.longitude),
        orderUrl: `https://www.discocater.com/order/${r.businessNameWithoutSpaces || slugify(r.businessName || '')}`,
        active: true,
      }

      // Fetch the FULL existing doc so createOrReplace preserves any custom
      // Disco data (image, cuisines[], tags, manual edits, …) — replacing with
      // only the listed fields would wipe them. Defaults are applied ONLY when
      // the field is absent.
      const existing = (await sanity.fetch(`*[_id == $id][0]`, { id })) as SanityDoc | null

      const preserved: SanityDoc = {}
      if (existing) {
        for (const [k, v] of Object.entries(existing)) {
          if (k === '_id' || k === '_rev' || k === '_type' || k === '_createdAt' || k === '_updatedAt') continue
          preserved[k] = v
        }
      }

      const slug = existing?.slug ?? { _type: 'slug', current: slugify(r.businessNameWithoutSpaces || r.businessName || ref) }

      const doc = {
        _id: id,
        _type: 'restaurant',
        ...preserved,
        // Defaults — only fill when not already present on the existing doc.
        slug,
        isDisco: existing?.isDisco ?? false,
        featured: existing?.featured ?? false,
        cuisine: existing?.cuisine ?? 'Other',
        description: existing?.description ?? '',
        // FM fields last so they always win.
        ...fmFields,
      }

      await sanity.createOrReplace(doc)
      if (existing) updated++
      else newCount++
    } catch (e) {
      errors.push(`upsert ${ref}: ${e instanceof Error ? e.message : String(e)}`)
    }

    processed++
    if (processed % 50 === 0) console.log(`[sync-restaurants] processed ${processed}/${qualifying.length}`)
    await sleep(100) // gentle on the Sanity write API
  }

  // STEP 4 — deactivate Sanity docs whose fmReference is no longer qualifying.
  // Never delete: they may carry custom Disco data.
  try {
    const docs = (await sanity.fetch(
      `*[_type == "restaurant" && defined(fmReference)]{ _id, fmReference, active }`,
    )) as { _id: string; fmReference?: string; active?: boolean }[]

    for (const d of docs) {
      if (d.fmReference && qualifyingRefs.has(d.fmReference)) continue // active:true already set in STEP 3
      if (d.active === false) continue // already inactive — no-op
      try {
        await sanity.patch(d._id).set({ active: false }).commit()
        deactivated++
        await sleep(100)
      } catch (e) {
        errors.push(`deactivate ${d._id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    errors.push(`deactivation pass: ${e instanceof Error ? e.message : String(e)}`)
  }

  const synced = newCount + updated
  console.log(`[sync-restaurants] done — synced ${synced} (new ${newCount}, updated ${updated}), deactivated ${deactivated}, skipped ${skipped}, errors ${errors.length}`)

  return { success: true, synced, new: newCount, updated, deactivated, skipped, errors }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handle(): Promise<NextResponse> {
  if (!process.env.SANITY_TOKEN) {
    return NextResponse.json({ success: false, error: 'SANITY_TOKEN not configured on the server' }, { status: 500 })
  }
  try {
    return NextResponse.json(await runSync())
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Sync failed' }, { status: 500 })
  }
}

// Vercel Cron + CLI — Bearer CRON_SECRET only.
export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}

// Super-admin button — admin session cookie OR Bearer CRON_SECRET.
export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || !!getAdminTokenFromRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}
