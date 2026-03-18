// Fetches Google Places photos for all restaurants and uploads to Sanity
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
      // Handle redirects
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

// ── Upload image buffer to Sanity ────────────────────────────────────────────

async function uploadImageToSanity(imageBuffer: Buffer, filename: string) {
  const asset = await sanity.assets.upload('image', imageBuffer, {
    filename,
    contentType: 'image/jpeg',
  })
  return asset._id
}

// ── Search Google Places ─────────────────────────────────────────────────────

async function findPlaceId(name: string, location: string): Promise<string | null> {
  const query = encodeURIComponent(`${name} ${location}`)
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name&key=${GOOGLE_KEY}`
  const data = await fetchJson(url)
  if (data.candidates && data.candidates.length > 0) {
    return data.candidates[0].place_id
  }
  return null
}

async function getPhotoReference(placeId: string): Promise<string | null> {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=photos,name&key=${GOOGLE_KEY}`
  const data = await fetchJson(url)
  if (data.result?.photos && data.result.photos.length > 0) {
    return data.result.photos[0].photo_reference
  }
  return null
}

async function getPhotoBuffer(photoReference: string): Promise<Buffer> {
  const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${photoReference}&key=${GOOGLE_KEY}`
  return fetchBuffer(url)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Fetch all restaurants from Sanity that don't have an image yet
  const restaurants = await sanity.fetch(`
    *[_type == "restaurant" && !defined(image)] {
      _id, name, location
    }
  `)

  console.log(`Found ${restaurants.length} restaurants without images\n`)

  let success = 0
  let failed = 0

  for (const r of restaurants) {
    try {
      process.stdout.write(`Processing: ${r.name}... `)

      // 1. Find place ID
      const placeId = await findPlaceId(r.name, r.location)
      if (!placeId) {
        console.log('✗ Not found on Google Places')
        failed++
        await sleep(200)
        continue
      }

      // 2. Get photo reference
      const photoRef = await getPhotoReference(placeId)
      if (!photoRef) {
        console.log('✗ No photos available')
        failed++
        await sleep(200)
        continue
      }

      // 3. Download photo
      const buffer = await getPhotoBuffer(photoRef)

      // 4. Upload to Sanity
      const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const assetId = await uploadImageToSanity(buffer, `${slug}.jpg`)

      // 5. Patch restaurant document with image
      await sanity.patch(r._id).set({
        image: {
          _type: 'image',
          asset: { _type: 'reference', _ref: assetId },
        }
      }).commit()

      console.log('✓')
      success++

      // Be polite to the API
      await sleep(300)

    } catch (e: any) {
      console.log(`✗ Error: ${e.message}`)
      failed++
      await sleep(300)
    }
  }

  console.log(`\nDone! ✓ ${success} images added · ✗ ${failed} failed`)
}

main()