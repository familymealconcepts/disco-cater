import { NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// One-time import: pull cuisine / description / image from published Sanity
// restaurant docs into disco_restaurant_cache. FM owns name/slug/coords (via the
// refresh route); Sanity owns the editorial fields. Admin-cookie gated.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  useCdn: false,
})

interface SanityDoc {
  name?: string
  slug?: string
  cuisine?: string
  description?: string
  image?: string
  lat?: number
  lng?: number
  location?: string
  fmReference?: string
  isDisco?: boolean
}

export async function POST() {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    await runMigrations()

    // Published restaurant docs only (exclude drafts).
    const docs = (await sanity.fetch(`
      *[_type == "restaurant" && !(_id in path("drafts.**"))]{
        name,
        "slug": slug.current,
        "cuisine": coalesce(cuisines[0], cuisine),
        description,
        "image": image.asset->url,
        lat,
        lng,
        location,
        fmReference,
        isDisco
      }
    `)) as SanityDoc[]

    let matched = 0
    let inserted = 0
    let skipped = 0
    let premium = 0

    // Flip is_premium = true on the override row for a Premium (isDisco) Sanity
    // doc, keying off the resolved cache reference. ON CONFLICT only touches
    // is_premium — visible / stripe_connected (admin-managed) are left as-is.
    // Never sets false, so a doc with isDisco unset/false never clears a flag.
    async function setPremium(ref: string) {
      if (!ref) return
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, is_premium, visible, stripe_connected)
        VALUES (${ref}, true, false, false)
        ON CONFLICT (restaurant_reference) DO UPDATE SET is_premium = true, updated_at = NOW()
      `
      premium++
    }

    for (const d of docs) {
      const slug = d.slug ? String(d.slug) : ''
      const name = d.name ? String(d.name) : ''
      const fmRef = d.fmReference ? String(d.fmReference) : ''
      if (!slug && !fmRef) { skipped++; continue }

      const cuisine = d.cuisine ? String(d.cuisine) : 'Other'
      const description = d.description ? String(d.description) : null
      const imageUrl = d.image ? String(d.image) : null

      // Update an existing cache row matched by slug or (case-insensitive) name.
      const updated = (await sql`
        UPDATE disco_restaurant_cache
        SET cuisine = ${cuisine}, description = ${description}, image_url = ${imageUrl}
        WHERE (${slug} <> '' AND slug = ${slug})
           OR (${name} <> '' AND name ILIKE ${name})
        RETURNING restaurant_reference
      `) as { restaurant_reference: string }[]

      if (updated.length > 0) {
        matched++
        if (d.isDisco === true) {
          for (const row of updated) await setPremium(row.restaurant_reference)
        }
        continue
      }

      // Not in the cache yet → insert a Sanity-sourced row keyed by FM reference
      // (preferred) or slug. Coords may be absent (then it won't show until FM
      // refresh supplies them under the same reference).
      const key = fmRef || slug
      const lat = typeof d.lat === 'number' && Number.isFinite(d.lat) ? d.lat : null
      const lng = typeof d.lng === 'number' && Number.isFinite(d.lng) ? d.lng : null
      const location = d.location ? String(d.location) : null

      const ins = (await sql`
        INSERT INTO disco_restaurant_cache
          (restaurant_reference, name, slug, cuisine, description, image_url, lat, lng, location, cached_at)
        VALUES (${key}, ${name || key}, ${slug || null}, ${cuisine}, ${description}, ${imageUrl}, ${lat}, ${lng}, ${location}, NOW())
        ON CONFLICT (restaurant_reference) DO NOTHING
        RETURNING restaurant_reference
      `) as { restaurant_reference: string }[]

      if (ins.length > 0) {
        inserted++
        if (d.isDisco === true) await setPremium(key)
      } else skipped++
    }

    console.log(`[import-sanity-restaurants] matched ${matched}, inserted ${inserted}, skipped ${skipped}, premium ${premium} (of ${docs.length} docs)`)
    return NextResponse.json({ matched, inserted, skipped, premium })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[import-sanity-restaurants] failed:', message, e instanceof Error ? e.stack : '')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
