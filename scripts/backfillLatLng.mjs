import { createClient } from '@sanity/client'

const DRY_RUN = process.argv.includes('--dry-run')

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  token: process.env.SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
})

async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`
  const res = await fetch(url, { headers: { 'User-Agent': 'DiscoCater/1.0' } })
  const data = await res.json()
  if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  return null
}

async function run() {
  if (DRY_RUN) console.log('DRY RUN — no changes will be written\n')

  const docs = await client.fetch(
    `*[_type == "restaurant" && defined(address) && (!defined(lat) || !defined(lng))]{_id, name, address}`
  )
  console.log(`Found ${docs.length} restaurants missing lat/lng\n`)
  if (docs.length === 0) { console.log('Nothing to do.'); return }

  let updated = 0, skipped = 0
  for (const r of docs) {
    const coords = await geocode(r.address)
    if (!coords) {
      console.log(`SKIP  "${r.name}" — geocode failed for: "${r.address}"`)
      skipped++
    } else {
      console.log(`${DRY_RUN ? 'WOULD SET' : 'UPDATED'}  "${r.name}" → lat:${coords.lat}, lng:${coords.lng}`)
      if (!DRY_RUN) await client.patch(r._id).set(coords).commit()
      updated++
    }
    // Nominatim rate limit: 1 req/sec
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`\nUpdated: ${updated} | Skipped: ${skipped} | Total: ${docs.length}`)
}

run().catch(console.error)
