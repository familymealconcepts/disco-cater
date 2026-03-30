// Fetches Google Places photos for all restaurants and uploads to Sanity
// Scores all available photos to pick the best food shot (skips exteriors, logos, menus)
// Run from disco-cater folder:
//   SANITY_TOKEN=your_token GOOGLE_PLACES_API_KEY=your_key npx ts-node --skip-project scripts/fetchRestaurantImages.ts

import { createClient } from '@sanity/client'
import * as https from 'https'
import * as http from 'http'

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  token: process.env.SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
})

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY

// ── Helpers ─────────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBuffer(res.headers.location!).then(resolve).catch(reject)
      }
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Photo scoring ────────────────────────────────────────────────────────────
// Google Places photos have html_attributions and sometimes type hints in the
// attribution text. We score based on signals to prefer food shots.

type PlacesPhoto = {
  photo_reference: string
  width: number
  height: number
  html_attributions: string[]
}

function scorePhoto(photo: PlacesPhoto): number {
  let score = 0

  const attribution = (photo.html_attributions || []).join(' ').toLowerCase()

  // Penalise likely exterior / street / logo shots
  if (attribution.includes('exterior') || attribution.includes('outside') || attribution.includes('storefront')) score -= 20
  if (attribution.includes('logo') || attribution.includes('icon') || attribution.includes('brand')) score -= 20
  if (attribution.includes('menu') || attribution.includes('price list')) score -= 10

  // Reward likely food shots
  if (attribution.includes('food') || attribution.includes('dish') || attribution.includes('meal')) score += 20
  if (attribution.includes('catering') || attribution.includes('platter') || attribution.includes('spread')) score += 15
  if (attribution.includes('inside') || attribution.includes('interior') || attribution.includes('dining')) score += 5

  // Prefer landscape orientation (food platters/spreads are usually landscape)
  if (photo.width > photo.height) score += 10

  // Prefer higher resolution photos (more likely to be professional shots)
  if (photo.width >= 1200) score += 15
  else if (photo.width >= 800) score += 8

  // Photos later in the list are often user-submitted food shots
  // (Google tends to put their own exterior photo first)
  // We'll apply an index bonus externally

  return score
}

function pickBestPhoto(photos: PlacesPhoto[]): string {
  if (photos.length === 0) return ''
  if (photos.length === 1) return photos[0].photo_reference

  const scored = photos.map((photo, index) => ({
    photo,
    // Add a small bonus for photos further in the list (index 2-6 tend to be food)
    // but don't let it overwhelm the content signals
    score: scorePhoto(photo) + (index >= 1 && index <= 6 ? index * 2 : 0),
  }))

  scored.sort((a, b) => b.score - a.score)

  console.log(`    → ${photos.length} photos available, scores: ${scored.slice(0, 5).map(s => s.score).join(', ')}`)

  return scored[0].photo.photo_reference
}

// ── Upload image buffer to Sanity ────────────────────────────────────────────

async function uploadImageToSanity(imageBuffer: Buffer, filename: string) {
  const asset = await sanity.assets.upload('image', imageBuffer, {
    filename,
    contentType: 'image/jpeg',
  })
  return asset._id
}

// ── Google Places API ────────────────────────────────────────────────────────

async function findPlaceId(name: string, location: string): Promise<string | null> {
  const query = encodeURIComponent(`${name} ${location}`)
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name&key=${GOOGLE_KEY}`
  const data = await fetchJson(url)
  if (data.candidates && data.candidates.length > 0) {
    return data.candidates[0].place_id
  }
  return null
}

async function getAllPhotos(placeId: string): Promise<PlacesPhoto[]> {
  // Request up to 10 photos (Google Places API max per call)
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=photos,name&key=${GOOGLE_KEY}`
  const data = await fetchJson(url)
  if (data.result?.photos && data.result.photos.length > 0) {
    return data.result.photos // returns up to 10
  }
  return []
}

async function getPhotoBuffer(photoReference: string): Promise<Buffer> {
  const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=${photoReference}&key=${GOOGLE_KEY}`
  return fetchBuffer(url)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Set REFRESH=true to re-process restaurants that already have images
  const refresh = process.env.REFRESH === 'true'

  const query = refresh
    ? `*[_type == "restaurant"] { _id, name, location }`
    : `*[_type == "restaurant" && !defined(image)] { _id, name, location }`

  const restaurants = await sanity.fetch(query)

  console.log(`Found ${restaurants.length} restaurants to process`)
  console.log(`Mode: ${refresh ? 'REFRESH (overwriting existing images)' : 'NEW ONLY (skipping restaurants with images)'}\n`)

  let success = 0
  let failed = 0
  let skipped = 0

  for (const r of restaurants) {
    try {
      process.stdout.write(`Processing: ${r.name} (${r.location})...\n`)

      // 1. Find place ID
      const placeId = await findPlaceId(r.name, r.location)
      if (!placeId) {
        console.log('  ✗ Not found on Google Places\n')
        failed++
        await sleep(200)
        continue
      }

      // 2. Get all available photos
      const photos = await getAllPhotos(placeId)
      if (photos.length === 0) {
        console.log('  ✗ No photos available\n')
        failed++
        await sleep(200)
        continue
      }

      // 3. Score and pick the best food photo
      const bestPhotoRef = pickBestPhoto(photos)

      // 4. Download best photo at higher resolution (1200px wide)
      const buffer = await getPhotoBuffer(bestPhotoRef)

      // 5. Upload to Sanity
      const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const assetId = await uploadImageToSanity(buffer, `${slug}.jpg`)

      // 6. Patch restaurant document
      await sanity.patch(r._id).set({
        image: {
          _type: 'image',
          asset: { _type: 'reference', _ref: assetId },
        }
      }).commit()

      console.log(`  ✓ Done\n`)
      success++

      await sleep(300)

    } catch (e: any) {
      console.log(`  ✗ Error: ${e.message}\n`)
      failed++
      await sleep(300)
    }
  }

  console.log(`\n────────────────────────────────────`)
  console.log(`Done!`)
  console.log(`✓ ${success} images updated`)
  console.log(`✗ ${failed} failed`)
  if (skipped > 0) console.log(`– ${skipped} skipped`)
}

main()