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

// Allowed cuisine vocabulary Claude must pick from (mirrors TYPE_TO_CUISINE values).
const ALLOWED_CUISINES = [
  'American', 'Italian', 'Mexican', 'Japanese', 'Chinese', 'Indian',
  'Mediterranean', 'Thai', 'Korean', 'French', 'Middle Eastern', 'Caribbean',
  'BBQ', 'Vegan', 'Sandwiches', 'Bagels', 'Pizza', 'Deli', 'Chicken', 'Breakfast',
]

// Validate Claude's reply against the allowed list (tolerant of trailing
// punctuation / case), returning the canonical value or null if unrecognised.
function normalizeCuisine(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const cleaned = text.trim().replace(/[.\s]+$/, '').trim().toLowerCase()
  return ALLOWED_CUISINES.find((c) => c.toLowerCase() === cleaned) ?? null
}

// Infer cuisine with Claude (Haiku) — far more accurate for restaurant names
// than the Places type map. Pass the Google `types` + description when Places
// returned a match; pass neither to infer from the name alone (Places miss).
// Returns a validated cuisine or null (caller falls back to the type map / Other).
async function inferCuisineWithClaude(
  name: string,
  types: string[] | null,
  description: string | null,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const values = ALLOWED_CUISINES.join(', ')
  const content = (types && types.length)
    ? `What cuisine type best describes this restaurant? Restaurant name: ${name}. Google Places types: ${types.join(', ')}. Description: ${description || 'N/A'}. Reply with ONLY one of these exact values: ${values}. No other text.`
    : `What cuisine type best describes this restaurant based on its name alone? Restaurant name: ${name}. Reply with ONLY one of these exact values: ${values}. No other text.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content }],
      }),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    const text = (Array.isArray(data?.content) ? data.content.find((b: { type?: string }) => b?.type === 'text') : null)?.text
    return normalizeCuisine(text)
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface PlaceResult {
  cuisine: string | null   // Places type-map result (fallback if Claude fails)
  types: string[]          // raw Google Places types (fed to Claude)
  description: string | null
  imageUrl: string | null
}

// One Places lookup for a restaurant. Returns whatever fields Google could
// supply; nulls mean "no value, leave the existing column alone".
async function lookupPlace(name: string, address: string | null, debug = false): Promise<PlaceResult | null> {
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
  if (debug) {
    console.log('[Enrich] Places response for first restaurant:', JSON.stringify(data, null, 2))
  }
  const place = data?.places?.[0]
  if (!place) return null

  const cuisine = mapCuisine(place.types)
  const types: string[] = Array.isArray(place.types) ? place.types.map(String) : []

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

  return { cuisine, types, description, imageUrl }
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

    // cuisine/description/image_url are selected only so the debug log below can
    // report what each candidate already has; the enrichment logic uses just
    // restaurant_reference/name/address.
    const restaurants = (await sql`
      SELECT restaurant_reference, name, address, location, cuisine, description, image_url FROM disco_restaurant_cache
      WHERE cuisine = 'Other' OR cuisine IS NULL OR image_url IS NULL OR description IS NULL
      ORDER BY restaurant_reference
      LIMIT ${batchSize} OFFSET ${offset}
    `) as { restaurant_reference: string; name: string; address: string | null; location: string | null; cuisine: string | null; description: string | null; image_url: string | null }[]

    console.log('[Enrich] Batch info:', {
      offset,
      batchSize,
      rowsFound: restaurants.length,
      sample: restaurants.slice(0, 2).map(r => ({ name: r.name, cuisine: r.cuisine, hasImage: !!r.image_url, hasDesc: !!r.description })),
    })

    let enriched = 0
    let skipped = 0
    let notFound = 0

    for (let i = 0; i < restaurants.length; i++) {
      const r = restaurants[i]
      let result: PlaceResult | null = null
      try {
        // Dump the raw Places response for the first restaurant of the batch.
        result = await lookupPlace(r.name, r.address, i === 0)
      } catch (err) {
        console.error(`[enrich-restaurants-places] lookup failed for ${r.restaurant_reference}:`, err instanceof Error ? err.message : err)
      }

      if (!result) {
        // No Google match — still infer cuisine from the name alone (Claude can
        // read "El Gallo Taqueria" → Mexican) so the row never stays "Other".
        // Only cuisine is written; description/image are left untouched.
        const cuisine = (await inferCuisineWithClaude(r.name, null, null)) || 'Other'
        await sql`
          UPDATE disco_restaurant_cache
          SET cuisine = COALESCE(${cuisine}, cuisine),
              description = COALESCE(${null}, description),
              image_url = COALESCE(${null}, image_url),
              cached_at = NOW()
          WHERE restaurant_reference = ${r.restaurant_reference}
        `
        notFound++
        await sleep(200)
        continue
      }

      // Infer cuisine with Claude (more accurate than the Places type map),
      // falling back to the Places type mapping, then "Other".
      result.cuisine =
        (await inferCuisineWithClaude(r.name, result.types, result.description))
        || result.cuisine
        || 'Other'

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
