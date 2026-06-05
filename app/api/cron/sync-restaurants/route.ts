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
  // Use the working admin restaurants list endpoint (the same one
  // app/api/admin/restaurants/route.ts proxies for the ordering page + admin
  // dashboard): GET ${FM}/api/admin/restaurants. The `/api/admin/restaurants/
  // marketplace` path has no `/marketplace` sub-route on FM — it's matched by
  // `/api/admin/restaurants/{reference}`, so FM tries to parse "marketplace" as a
  // UUID and 400s. The plain list returns the same restaurant objects
  // (restaurantStatus, blocked, address) the marketplace filters below key on.
  // Param shape mirrors that route exactly: omit `page` when 0, size only. We do
  // NOT send restaurantStatus — FM's RestaurantStatus enum has no "ACTIVE"
  // constant (the admin UI's default is "All statuses", i.e. no filter), so we
  // fetch all restaurants and filter to ACTIVE client-side via isActive().
  const size = 25
  // 1000-page hard cap is a runaway-loop backstop, far above any real count.
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(size))
    const res = await fetch(`${FM}/api/admin/restaurants?${params}`, {
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) {
      const errBody = await res.text()
      console.log('[sync] marketplace 400 body:', errBody)
    }
    if (!res.ok) throw new Error(`FM restaurants fetch failed (page ${page}, HTTP ${res.status})`)
    const d = await res.json().catch(() => null)
    const content: FmRestaurant[] = Array.isArray(d) ? d : (d?.content || d?.data || [])

    // ── Diagnostics: dump the raw FM object shape from the first page only,
    //    before any filtering. Remove once the address/coords shape is confirmed.
    if (page === 0) {
      const sample = content?.[0] as (FmRestaurant & Record<string, unknown>) | undefined
      console.log('[sync-diag] total in first page:', content?.length)
      console.log('[sync-diag] top-level keys:', sample ? Object.keys(sample).join(', ') : 'NO SAMPLE')
      console.log('[sync-diag] address field:', JSON.stringify(sample?.address))
      console.log('[sync-diag] first restaurant blocked:', sample?.blocked, 'status:', sample?.restaurantStatus || sample?.status)
      if (sample) {
        console.log('[sync-diag] addressLine1:', sample?.address?.addressLine1)
        console.log('[sync-diag] city:', sample?.address?.city)
        console.log('[sync-diag] state:', sample?.address?.state)
        console.log('[sync-diag] zipcode:', sample?.address?.zipcode)
      }
    }

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
// Full street address (no coordinates). The FM LIST endpoint omits lat/lng, so
// coordinates are fetched separately from the detail endpoint (fetchDetail).
function hasAddressParts(a?: FmAddress): boolean {
  if (!a) return false
  return !!(a.addressLine1 && a.city && a.state && a.zipcode)
}

// FM detail endpoint — its address DOES include latitude/longitude (the list
// endpoint does not). Returns null on any failure (treated as "no coords").
async function fetchDetail(token: string, ref: string): Promise<FmRestaurant | null> {
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, {
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as FmRestaurant | null
  } catch {
    return null
  }
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
  let skippedNoAddress = 0
  let skippedNoCoords = 0

  // STEP 1
  const token = await fmLogin()

  // STEP 2
  const all = await fetchAllMarketplace(token)
  console.log(`[sync-restaurants] fetched ${all.length} marketplace restaurants from FM`)

  // Classify: keep ACTIVE + not-blocked rows that have a full STREET address.
  // We do NOT require coordinates here — the FM list omits lat/lng, so coords are
  // fetched from the detail endpoint below. (Requiring coords here was the bug
  // that rejected all 4329.) Inactive/blocked rows are neither processed nor
  // protected → STEP 4 may deactivate them.
  const withAddress: FmRestaurant[] = []
  for (const r of all) {
    if (!r.reference) continue
    const active = isActive(r)
    // "not blocked" — treat absent `blocked` as not blocked (FM marketplace
    // visibility), only excluding rows explicitly blocked === true.
    const notBlocked = r.blocked !== true
    if (!active || !notBlocked) continue
    if (hasAddressParts(r.address)) withAddress.push(r)
    else skippedNoAddress++ // active + unblocked but missing a street address
  }
  // Every active/unblocked/full-address restaurant counts as "qualifying" for the
  // STEP 4 deactivation guard — INCLUDING ones we don't process this run (cap) or
  // that lack coords — so a legitimately-active restaurant is never deactivated.
  const qualifyingRefs = new Set(withAddress.map((r) => r.reference as string))

  // Cap per run to stay within maxDuration: process the first 500; the next daily
  // run picks up the rest.
  const CAP = 500
  const cappedAt500 = withAddress.length > CAP
  const toProcess = withAddress.slice(0, CAP)
  console.log(`[sync-restaurants] ${withAddress.length} with full address, ${skippedNoAddress} skipped (no address); processing ${toProcess.length}${cappedAt500 ? ' (capped at 500)' : ''}`)

  // Fetch coordinates from the FM detail endpoint in batches of 10 concurrent
  // requests (200ms between batches). The list endpoint has no lat/lng. Rows
  // whose detail fails or has no coordinates are skipped this run.
  const ready: { r: FmRestaurant; address: FmAddress; lat: number; lng: number }[] = []
  const BATCH = 10
  const totalBatches = Math.ceil(toProcess.length / BATCH)
  for (let b = 0; b < totalBatches; b++) {
    const batch = toProcess.slice(b * BATCH, b * BATCH + BATCH)
    console.log(`[sync] processing batch ${b + 1}/${totalBatches} (restaurant ${b * BATCH + 1} of ${toProcess.length})`)
    const details = await Promise.all(batch.map((r) => fetchDetail(token, r.reference as string)))
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]
      const detail = details[i]
      // Prefer the detail address (carries coordinates); fall back to the list
      // address for the street parts.
      const a = (detail?.address ?? r.address) as FmAddress | undefined
      const lat = num(a?.latitude)
      const lng = num(a?.longitude)
      if (!a || lat == null || lng == null) { skippedNoCoords++; continue }
      // Merge so downstream fields prefer detail values when present.
      ready.push({ r: { ...r, ...(detail ?? {}) }, address: a, lat, lng })
    }
    if (b < totalBatches - 1) await sleep(200)
  }
  console.log(`[sync-restaurants] ${ready.length} ready to upsert, ${skippedNoCoords} skipped (no coords)`)

  // STEP 3 — upsert each coordinate-resolved restaurant into Sanity.
  let processed = 0
  for (const { r, address: a, lat, lng } of ready) {
    const ref = r.reference as string
    const id = `restaurant.fm-${ref}`
    try {
      // FM fields — ALWAYS overwrite.
      const fmFields = {
        name: r.businessName || '',
        fmReference: ref,
        address: `${a.addressLine1}, ${a.city}, ${a.state} ${a.zipcode}`,
        location: `${a.city}, ${a.state}`,
        lat,
        lng,
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
    if (processed % 50 === 0) console.log(`[sync-restaurants] upserted ${processed}/${ready.length}`)
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
  console.log(`[sync-restaurants] done — synced ${synced} (new ${newCount}, updated ${updated}), deactivated ${deactivated}, no-address ${skippedNoAddress}, no-coords ${skippedNoCoords}, capped ${cappedAt500}, errors ${errors.length}`)

  return {
    success: true,
    synced,
    new: newCount,
    updated,
    deactivated,
    skipped_no_address: skippedNoAddress,
    skipped_no_coords: skippedNoCoords,
    capped_at_500: cappedAt500,
    errors,
  }
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
