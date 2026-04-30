import { createClient } from '@sanity/client'

const DRY_RUN = process.argv.includes('--dry-run')

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  token: process.env.SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
})

function cityStateFromAddress(address) {
  if (!address) return null
  const match = address.match(/,\s*([A-Za-z\s]+),\s*([A-Z]{2})\s*\d{5}/)
  if (match) return `${match[1].trim()}, ${match[2].trim()}`
  const match2 = address.match(/,\s*([A-Za-z\s]+),\s*([A-Z]{2})\s*$/)
  if (match2) return `${match2[1].trim()}, ${match2[2].trim()}`
  const parts = address.split(',').map(p => p.trim())
  if (parts.length >= 2) {
    const rawState = parts[parts.length - 1].replace(/\s*\d{5}.*/, '').trim()
    const city = parts[parts.length - 2].trim()
    if (rawState.length === 2 && /^[A-Z]{2}$/.test(rawState)) {
      return `${city}, ${rawState}`
    }
  }
  return null
}

async function run() {
  if (DRY_RUN) console.log('DRY RUN — no changes will be written\n')
  const restaurants = await client.fetch(
    `*[_type == "restaurant" && defined(address) && (location == "" || !defined(location))]{_id, name, address, location}`
  )
  console.log(`Found ${restaurants.length} restaurants with address but no location\n`)
  if (restaurants.length === 0) { console.log('Nothing to do.'); return }
  let updated = 0, skipped = 0
  for (const r of restaurants) {
    const derived = cityStateFromAddress(r.address)
    if (!derived) { console.log(`SKIP  "${r.name}" — could not parse: "${r.address}"`); skipped++; continue }
    console.log(`${DRY_RUN ? 'WOULD SET' : 'UPDATED'}  "${r.name}": "${r.address}" → "${derived}"`)
    if (!DRY_RUN) await client.patch(r._id).set({ location: derived }).commit()
    updated++
  }
  console.log(`\nUpdated: ${updated} | Skipped: ${skipped} | Total: ${restaurants.length}`)
  if (DRY_RUN) console.log(`Re-run without --dry-run to apply.`)
}

run().catch(console.error)
