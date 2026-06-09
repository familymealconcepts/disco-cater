import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Enrich disco_restaurant_cache rows that are missing cuisine/description/image
// using the Google Places API (New) Text Search. For each candidate we search by
// "{name} {address}", map the returned place types to our cuisine vocabulary,
// pull the editorial summary as the description, and resolve the first photo to a
// hosted image URL. Admin-cookie gated.
//
// BATCHED: one POST processes a single page of `batchSize` (default 25) starting
// at `offset`, so each request stays under the function-duration limit. The
// client loops with the returned `nextOffset` until `done` is true.
//
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is referrer-restricted and may reject
// server-side calls, so prefer the server-only GOOGLE_PLACES_API_KEY.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const KEY =
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

const SEARCH_TEXT = 'https://places.googleapis.com/v1/places:searchText'

// Google Places `types` → our cuisine vocabulary. First match wins.
const TYPE_TO_CUISINE: Record<string, string> = {
  american_restaurant: 'American',
  italian_restaurant: 'Italian',
  mexican_restaurant: 'Mexican',
  japanese_restaurant: 'Japanese',
  chinese_restaurant: 'Chinese',
  indian_restaurant: 'Indian',
  mediterranean_restaurant: 'Mediterranean',
  thai_restaurant: 'Thai',
  korean_restaurant: 'Korean',
  french_restaurant: 'French',
  middle_eastern_restaurant: 'Middle Eastern',
  caribbean_restaurant: 'Caribbean',
  barbecue_restaurant: 'BBQ',
  vegan_restaurant: 'Vegan',
  sandwich_shop: 'Sandwiches',
  bagel_shop: 'Bagels',
  pizza_restaurant: 'Pizza',
  deli: 'Deli',
  chicken_restaurant: 'Chicken',
  breakfast_restaurant: 'Breakfast',
}

function mapCuisine(types: unknown): string | null {
  if (!Array.isArray(types)) return null
  for (const t of types) {
    const c = TYPE_TO_CUISINE[String(t)]
    if (c) return c
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface PlaceResult {
  cuisine: string | null
  description: string | null
  imageUrl: string | null
}

// One Places lookup for a restaurant. Returns whatever fields Google could
// supply; nulls mean "no value, leave the existing column alone".
async function lookupPlace(name: string, address: string | null): Promise<PlaceResult | null> {
  const textQuery = [name, address].filter(Boolean).join(' ').trim()
  if (!textQuery) return null

  const res = await fetch(SEARCH_TEXT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY as string,
      'X-Goog-FieldMask': 'places.id,places.types,places.editorialSummary,places.photos,places.displayName',
    },
    body: JSON.stringify({ textQuery }),
    cache: 'no-store',
  })
  const data = await res.json().catch(() => null)
  const place = data?.places?.[0]
  if (!place) return null

  const cuisine = mapCuisine(place.types)

  const summary = place.editorialSummary?.text
  const description = typeof summary === 'string' && summary.trim() ? summary.trim() : null

  let imageUrl: string | null = null
  const photoName = place.photos?.[0]?.name
  if (photoName) {
    try {
      const photoRes = await fetch(
        `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${KEY}`,
        { redirect: 'follow', cache: 'no-store' },
      )
      if (photoRes.ok && photoRes.url) imageUrl = photoRes.url
    } catch {
      // Photo resolution is best-effort; ignore failures.
    }
  }

  return { cuisine, description, imageUrl }
}

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  if (!KEY) {
    return NextResponse.json({ error: 'Google Places is not configured.' }, { status: 500 })
  }

  try {
    await runMigrations()
    const startedAt = Date.now()

    const body = await req.json().catch(() => null)
    const batchSize = Math.max(1, Math.min(500, Number(body?.batchSize) || 25))
    const offset = Math.max(0, Number(body?.offset) || 0)

    // Stable count + page of restaurants still missing at least one field.
    const totalRows = (await sql`
      SELECT COUNT(*)::int AS n FROM disco_restaurant_cache
      WHERE cuisine = 'Other' OR cuisine IS NULL OR image_url IS NULL OR description IS NULL
    `) as { n: number }[]
    const total = totalRows[0]?.n ?? 0

    const restaurants = (await sql`
      SELECT restaurant_reference, name, address, location FROM disco_restaurant_cache
      WHERE cuisine = 'Other' OR cuisine IS NULL OR image_url IS NULL OR description IS NULL
      ORDER BY restaurant_reference
      LIMIT ${batchSize} OFFSET ${offset}
    `) as { restaurant_reference: string; name: string; address: string | null; location: string | null }[]

    let enriched = 0
    let skipped = 0
    let notFound = 0

    for (const r of restaurants) {
      let result: PlaceResult | null = null
      try {
        result = await lookupPlace(r.name, r.address)
      } catch (err) {
        console.error(`[enrich-restaurants-places] lookup failed for ${r.restaurant_reference}:`, err instanceof Error ? err.message : err)
      }

      if (!result) {
        notFound++
        await sleep(200)
        continue
      }

      // Only update fields Google actually returned; leave the rest untouched.
      // COALESCE keeps the existing value when the parameter is null.
      if (result.cuisine || result.description || result.imageUrl) {
        await sql`
          UPDATE disco_restaurant_cache
          SET cuisine = COALESCE(${result.cuisine}, cuisine),
              description = COALESCE(${result.description}, description),
              image_url = COALESCE(${result.imageUrl}, image_url),
              cached_at = NOW()
          WHERE restaurant_reference = ${r.restaurant_reference}
        `
        enriched++
      } else {
        skipped++
      }

      // Throttle to stay under Places API rate limits.
      await sleep(200)
    }

    // Enriched rows drop OUT of the WHERE filter on the next run, but
    // skipped/notFound rows stay in it and slide to the front. So advance the
    // cursor only past those persistent rows — advancing by the full batch size
    // would skip the unprocessed rows that took the enriched rows' place.
    const nextOffset = offset + skipped + notFound
    // Done when this page returned fewer rows than asked (we hit the end). The
    // result set shrinks as rows get enriched, so this is the reliable terminator.
    const done = restaurants.length < batchSize

    return NextResponse.json({
      total,
      enriched,
      skipped,
      notFound,
      durationMs: Date.now() - startedAt,
      nextOffset,
      done,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[enrich-restaurants-places] failed:', message, e instanceof Error ? e.stack : '')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
